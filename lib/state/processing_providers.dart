import 'dart:math' as math;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/enums.dart';
import '../models/upload_ticket.dart';
import '../services/ai_editing_service.dart';
import '../services/media_upload_service.dart';
import 'providers.dart';

/// Явные этапы экрана обработки (§4D UX): загрузка и анализ разделены, а не
/// слиты в одну обезличенную «обработку».
enum ProcessingStage {
  /// Готовим запрос, этап ещё не определён.
  preparing('Готовим материалы'),

  /// Идёт прямая загрузка исходников в хранилище (прогресс по байтам).
  uploading('Загрузка материалов'),

  /// Материалы загружены, AI разбирает их (серверные phase/fraction).
  analyzing('AI анализирует материалы'),

  /// План собран — можно переходить к предпросмотру.
  done('Готово'),

  /// Пользователь отменил обработку.
  cancelled('Обработка отменена'),

  /// Ошибка на одном из этапов.
  failed('Не удалось обработать');

  const ProcessingStage(this.label);

  final String label;
}

/// К какому этапу относится ошибка — чтобы не выдавать сбой загрузки за сбой AI.
enum ProcessingErrorStage { upload, analysis }

/// Ошибка обработки с понятным сообщением и указанием этапа.
class ProcessingError {
  const ProcessingError({
    required this.stage,
    required this.message,
    this.retryable = true,
  });

  final ProcessingErrorStage stage;
  final String message;
  final bool retryable;

  bool get isUpload => stage == ProcessingErrorStage.upload;
}

/// Состояние экрана обработки: раздельный прогресс двух этапов.
class ProcessingUiState {
  const ProcessingUiState({
    this.stage = ProcessingStage.preparing,
    this.upload = UploadProgress.empty,
    this.analysisFraction = 0,
    this.analysisMessage = '',
    this.error,
    this.cancelling = false,
  });

  final ProcessingStage stage;

  /// Прогресс загрузки (по фактически переданным байтам).
  final UploadProgress upload;

  /// Доля анализа 0..1 — монотонная и не достигает 1, пока анализ не завершён.
  final double analysisFraction;

  /// Что именно делает AI сейчас (серверное сообщение/название фазы).
  final String analysisMessage;

  final ProcessingError? error;

  final bool cancelling;

  ProcessingUiState copyWith({
    ProcessingStage? stage,
    UploadProgress? upload,
    double? analysisFraction,
    String? analysisMessage,
    Object? error = _keep,
    bool? cancelling,
  }) => ProcessingUiState(
    stage: stage ?? this.stage,
    upload: upload ?? this.upload,
    analysisFraction: analysisFraction ?? this.analysisFraction,
    analysisMessage: analysisMessage ?? this.analysisMessage,
    error: error == _keep ? this.error : error as ProcessingError?,
    cancelling: cancelling ?? this.cancelling,
  );

  bool get isUploading => stage == ProcessingStage.uploading;
  bool get isAnalyzing => stage == ProcessingStage.analyzing;
  bool get isDone => stage == ProcessingStage.done;

  bool get isBusy =>
      stage == ProcessingStage.preparing ||
      stage == ProcessingStage.uploading ||
      stage == ProcessingStage.analyzing;

  /// Отменить можно только живую обработку и только один раз.
  bool get canCancel => !cancelling && isBusy;

  bool get canRetry =>
      stage == ProcessingStage.failed || stage == ProcessingStage.cancelled;

  /// Доля загрузки 0..1. 100 % — только когда все файлы действительно переданы.
  double get uploadProgress => upload.fraction;

  /// Доля анализа 0..1. Ровно 1 показываем только на этапе [done].
  double get analysisProgress => isDone ? 1 : analysisFraction.clamp(0.0, 0.99);

  /// Загрузка завершена (все файлы переданы либо этап уже пройден).
  bool get uploadComplete =>
      upload.isDone ||
      stage == ProcessingStage.analyzing ||
      stage == ProcessingStage.done;

  /// Счётчик «Загружено X из N» без внутренних путей.
  String get uploadCounter {
    if (upload.totalFiles <= 0) return '';
    final done = uploadComplete ? upload.totalFiles : upload.completedFiles;
    return 'Загружено $done из ${upload.totalFiles}';
  }

  /// Имя текущего файла (только имя, без objectPath/локального пути).
  String get currentFileName => upload.currentFileName;

  static const Object _keep = Object();
}

final processingControllerProvider =
    NotifierProvider<ProcessingController, ProcessingUiState>(
      ProcessingController.new,
    );

/// Оркестратор экрана обработки: загрузка исходников → AI-анализ → план.
///
/// Реальную работу выполняет [AiEditingService] ([aiServiceProvider]); контроллер
/// лишь превращает его прогресс в раздельные этапы UI и разводит ошибки загрузки
/// и анализа. Загруженные материалы фиксируются в манифесте проекта, поэтому
/// повторный рендер их не грузит заново (§4D.3, §4D.9).
class ProcessingController extends Notifier<ProcessingUiState> {
  bool _disposed = false;
  bool _cancelRequested = false;
  bool _running = false;

  @override
  ProcessingUiState build() {
    ref.onDispose(() => _disposed = true);
    return const ProcessingUiState();
  }

  void _set(ProcessingUiState next) {
    if (_disposed) return;
    state = next;
  }

  /// Запускает обработку. Загрузка уже загруженных материалов пропускается —
  /// после перезагрузки страницы восстановленный проект сразу переходит к
  /// анализу и показывает верный этап.
  Future<void> start() async {
    if (_running) return; // единственный процесс за раз
    _running = true;
    _cancelRequested = false;

    final project = ref.read(projectProvider);
    if (project.assets.isEmpty) {
      _running = false;
      _set(
        const ProcessingUiState(
          stage: ProcessingStage.failed,
          error: ProcessingError(
            stage: ProcessingErrorStage.analysis,
            message: 'Нет материалов для обработки. Добавьте видео или фото.',
            retryable: false,
          ),
        ),
      );
      return;
    }

    _set(const ProcessingUiState());

    final service = ref.read(aiServiceProvider);
    try {
      final plan = await service.createEditPlan(
        project.toRequest(),
        onProgress: _onProgress,
      );
      if (_cancelRequested || _disposed) {
        _set(
          state.copyWith(stage: ProcessingStage.cancelled, cancelling: false),
        );
        return;
      }
      final controller = ref.read(projectProvider.notifier);
      controller.setPlan(plan);
      controller.setStage(AppStage.preview);
      _set(
        state.copyWith(
          stage: ProcessingStage.done,
          analysisFraction: 1,
          cancelling: false,
          error: null,
        ),
      );
    } on MediaUploadCancelled {
      _set(state.copyWith(stage: ProcessingStage.cancelled, cancelling: false));
    } on MediaUploadException catch (e) {
      // Сбой загрузки — это сбой загрузки, а не «ошибка Gemini».
      _fail(
        ProcessingError(
          stage: ProcessingErrorStage.upload,
          message: e.message,
          retryable: e.retryable,
        ),
      );
    } on AiEditingException catch (e) {
      if (_cancelRequested) {
        _set(
          state.copyWith(stage: ProcessingStage.cancelled, cancelling: false),
        );
      } else {
        _fail(
          ProcessingError(
            stage: ProcessingErrorStage.analysis,
            message: e.message,
          ),
        );
      }
    } catch (_) {
      _fail(
        const ProcessingError(
          stage: ProcessingErrorStage.analysis,
          message: 'Не удалось собрать ролик. Попробуйте ещё раз.',
        ),
      );
    } finally {
      _running = false;
    }
  }

  /// Повтор после ошибки/отмены — начинаем заново. Уже загруженные материалы
  /// в манифесте не грузятся повторно.
  Future<void> retry() async {
    if (_running) return;
    _set(const ProcessingUiState());
    await start();
  }

  /// Кооперативная отмена: прерывает загрузку и анализ на ближайшей проверке.
  void cancel() {
    if (!state.canCancel) return;
    _cancelRequested = true;
    _set(state.copyWith(cancelling: true));
    ref.read(aiServiceProvider).cancel();
  }

  void _onProgress(ProcessingProgress progress) {
    if (_disposed || _cancelRequested) return;
    switch (progress.phase) {
      case ProcessingPhase.uploading:
        _set(
          state.copyWith(
            stage: ProcessingStage.uploading,
            upload: progress.upload,
          ),
        );
      case ProcessingPhase.analyzing:
        // Монотонность: доля анализа только растёт, даже если сервер на повторе
        // прислал меньшее значение. До завершения держим ниже 100 %.
        final next = math
            .max(state.analysisFraction, progress.analysisFraction)
            .clamp(0.0, 0.99);
        _set(
          state.copyWith(
            stage: ProcessingStage.analyzing,
            analysisFraction: next,
            analysisMessage: progress.analysisMessage,
          ),
        );
    }
  }

  void _fail(ProcessingError error) {
    _set(
      state.copyWith(
        stage: ProcessingStage.failed,
        error: error,
        cancelling: false,
      ),
    );
  }
}
