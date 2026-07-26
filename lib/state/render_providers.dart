import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/render_job.dart';
import '../models/render_request.dart';
import '../models/upload_ticket.dart';
import '../services/media_upload_service.dart';
import '../services/render_api_client.dart';
import 'providers.dart';

/// Параметры поллинга статуса задачи (§8 контракта: 2 с с backoff до 10 с).
class RenderPollConfig {
  const RenderPollConfig({
    this.initial = const Duration(seconds: 2),
    this.max = const Duration(seconds: 10),
    this.overallTimeout = const Duration(minutes: 30),
    this.maxConsecutiveErrors = 5,
  });

  final Duration initial;
  final Duration max;

  /// Предохранитель клиента: сервер сам помечает зависшие задачи, но и клиент
  /// не должен опрашивать вечно.
  final Duration overallTimeout;

  /// Сколько подряд идущих временных ошибок терпим, прежде чем показать сбой.
  final int maxConsecutiveErrors;

  /// Следующий интервал: полтора раза больше текущего, но не выше [max].
  Duration nextInterval(Duration current) {
    final ms = (current.inMilliseconds * 3) ~/ 2;
    return ms >= max.inMilliseconds ? max : Duration(milliseconds: ms);
  }
}

/// Понятные пользователю состояния сценария рендера.
enum RenderUiStage {
  /// План собран, MP4 ещё не заказан.
  planReady('Монтажный план готов'),

  /// Идёт прямая загрузка исходников в хранилище.
  uploading('Загружаем материалы'),

  /// Материалы загружены, задача отправляется на сервер.
  submitting('Отправляем задачу на рендер'),

  /// Задача принята и выполняется.
  rendering('MP4 создаётся'),

  /// Готово — и только после реального терминального успеха.
  ready('MP4 готов к скачиванию'),

  /// Задача завершилась ошибкой либо запрос не удалось выполнить.
  failed('Ошибка рендеринга'),

  /// Пользователь отменил рендер.
  cancelled('Рендер отменён');

  const RenderUiStage(this.label);

  final String label;
}

/// Состояние экрана рендера.
class RenderUiState {
  const RenderUiState({
    this.stage = RenderUiStage.planReady,
    this.upload = UploadProgress.empty,
    this.job,
    this.error,
    this.cancelling = false,
    this.preparingDownload = false,
    this.restoring = false,
  });

  final RenderUiStage stage;

  /// Прогресс прямой загрузки материалов.
  final UploadProgress upload;

  final RenderJob? job;

  /// Последняя ошибка сценария (сеть, валидация, ошибка задачи).
  final RenderError? error;

  final bool cancelling;

  /// Идёт запрос свежего signed URL перед скачиванием.
  final bool preparingDownload;

  /// Идёт восстановление активной задачи после перезагрузки страницы.
  final bool restoring;

  RenderUiState copyWith({
    RenderUiStage? stage,
    UploadProgress? upload,
    Object? job = _keep,
    Object? error = _keep,
    bool? cancelling,
    bool? preparingDownload,
    bool? restoring,
  }) => RenderUiState(
    stage: stage ?? this.stage,
    upload: upload ?? this.upload,
    job: job == _keep ? this.job : job as RenderJob?,
    error: error == _keep ? this.error : error as RenderError?,
    cancelling: cancelling ?? this.cancelling,
    preparingDownload: preparingDownload ?? this.preparingDownload,
    restoring: restoring ?? this.restoring,
  );

  /// Идёт ли длительная операция, которую нельзя запускать повторно.
  bool get isBusy =>
      restoring ||
      stage == RenderUiStage.uploading ||
      stage == RenderUiStage.submitting ||
      stage == RenderUiStage.rendering;

  /// MP4 действительно готов: терминальный успех **и** есть результат.
  bool get isMp4Ready =>
      stage == RenderUiStage.ready &&
      (job?.isSucceeded ?? false) &&
      job?.result != null;

  bool get canStart =>
      !isBusy &&
      (stage == RenderUiStage.planReady ||
          stage == RenderUiStage.failed ||
          stage == RenderUiStage.cancelled);

  /// Отменить можно только живую задачу и только один раз.
  bool get canCancel =>
      !cancelling &&
      (stage == RenderUiStage.uploading ||
          stage == RenderUiStage.submitting ||
          (stage == RenderUiStage.rendering &&
              !(job?.cancelRequested ?? false)));

  bool get canRetry =>
      !isBusy &&
      (stage == RenderUiStage.failed || stage == RenderUiStage.cancelled);

  bool get canDownload => isMp4Ready && !preparingDownload;

  /// Прогресс загрузки материалов 0..1.
  double get uploadProgress => upload.fraction;

  /// Прогресс рендера 0..1 из состояния задачи.
  double get renderProgress => job?.progress ?? 0;

  /// Сквозной прогресс: загрузка занимает первые 15 %, рендер — остальное.
  double get overallProgress => switch (stage) {
    RenderUiStage.planReady => 0,
    RenderUiStage.uploading => uploadProgress * 0.15,
    RenderUiStage.submitting => 0.15,
    RenderUiStage.rendering => 0.15 + renderProgress * 0.85,
    RenderUiStage.ready => 1,
    RenderUiStage.failed || RenderUiStage.cancelled => renderProgress,
  };

  /// Подробность под заголовком состояния.
  String get detail => switch (stage) {
    RenderUiStage.planReady => 'Выберите качество и соберите MP4 на сервере.',
    RenderUiStage.uploading =>
      upload.isEmpty
          ? 'Готовим материалы к загрузке…'
          : '${upload.label} · ${upload.currentFileName}',
    RenderUiStage.submitting => 'Материалы загружены, ставим задачу в очередь.',
    RenderUiStage.rendering => _renderDetail,
    RenderUiStage.ready => 'Файл собран на сервере и готов к скачиванию.',
    RenderUiStage.failed => error?.message ?? 'Не удалось собрать MP4.',
    RenderUiStage.cancelled => 'Задача остановлена. Можно запустить заново.',
  };

  String get _renderDetail {
    final current = job;
    if (current == null) return 'Задача поставлена в очередь.';
    if (current.cancelRequested) return 'Останавливаем рендер…';
    final message = current.message.isNotEmpty
        ? current.message
        : current.phase.label;
    return '$message · ${(current.progress * 100).round()} %';
  }

  static const Object _keep = Object();
}

final renderApiClientProvider = Provider<RenderApiClient>((ref) {
  final client = RenderApiClient();
  ref.onDispose(client.close);
  return client;
});

final mediaUploadServiceProvider = Provider<MediaUploadService>((ref) {
  final service = MediaUploadService();
  ref.onDispose(service.close);
  return service;
});

final renderPollConfigProvider = Provider<RenderPollConfig>(
  (_) => const RenderPollConfig(),
);

final renderControllerProvider =
    NotifierProvider<RenderController, RenderUiState>(RenderController.new);

/// Сценарий рендера: загрузка исходников → `/render` → поллинг → скачивание.
class RenderController extends Notifier<RenderUiState> {
  bool _disposed = false;
  bool _cancelRequested = false;
  int _pollGeneration = 0;
  Timer? _pollTimer;
  Completer<void>? _pollSleep;

  @override
  RenderUiState build() {
    ref.onDispose(() {
      _disposed = true;
      _pollGeneration++;
      _wakePoll();
    });
    return const RenderUiState();
  }

  /// Пауза между опросами, которую можно прервать: иначе после ухода с экрана
  /// висел бы таймер на несколько секунд.
  Future<void> _sleep(Duration duration) {
    _wakePoll();
    final completer = Completer<void>();
    _pollSleep = completer;
    _pollTimer = Timer(duration, () {
      if (!completer.isCompleted) completer.complete();
    });
    return completer.future;
  }

  void _wakePoll() {
    _pollTimer?.cancel();
    _pollTimer = null;
    final sleeping = _pollSleep;
    _pollSleep = null;
    if (sleeping != null && !sleeping.isCompleted) sleeping.complete();
  }

  RenderApiClient get _api => ref.read(renderApiClientProvider);
  MediaUploadService get _uploads => ref.read(mediaUploadServiceProvider);
  RenderPollConfig get _pollConfig => ref.read(renderPollConfigProvider);

  void _set(RenderUiState next) {
    if (_disposed) return;
    state = next;
  }

  /// Восстанавливает активную задачу после перезагрузки страницы.
  Future<void> restore() async {
    if (state.job != null || state.restoring) return;
    final project = ref.read(projectProvider);
    final storage = ref.read(storageServiceProvider);

    final jobId = await storage.loadActiveRenderJob(project.id);
    if (jobId == null || _disposed) return;

    _set(state.copyWith(restoring: true));
    try {
      final job = await _api.fetchJob(jobId);
      _applyJob(job);
      if (job.isActive) unawaited(_poll(job.jobId));
    } on RenderApiException catch (e) {
      // Задача не найдена или протухла — просто забываем её, без ошибки в UI.
      if (e.code == 'JOB_NOT_FOUND' || e.statusCode == 404) {
        await storage.clearActiveRenderJob();
      }
    } finally {
      _set(state.copyWith(restoring: false));
    }
  }

  /// Запускает полный сценарий: загрузка материалов → создание задачи.
  Future<void> start() async {
    if (state.isBusy) return;
    _cancelRequested = false;

    final project = ref.read(projectProvider);
    final storage = ref.read(storageServiceProvider);

    final RenderRequest draft;
    try {
      draft = RenderRequest.fromProject(project);
    } on RenderRequestException catch (e) {
      _fail(RenderError(code: 'PLAN_INVALID', message: e.message));
      return;
    }

    _set(
      RenderUiState(
        stage: RenderUiStage.uploading,
        upload: UploadProgress(
          completedFiles: 0,
          totalFiles: draft.assets.length,
        ),
      ),
    );

    try {
      final usedAssets = [
        for (final asset in project.assets)
          if (draft.assets.any((a) => a.id == asset.id)) asset,
      ];

      final tickets = await _api.requestUploadTickets(
        projectId: draft.projectId,
        assets: draft.assets,
        contentTypes: MediaUploadService.contentTypesOf(usedAssets),
      );
      _throwIfCancelled();

      final sizes = await _uploads.uploadAll(
        assets: usedAssets,
        tickets: tickets,
        onProgress: (progress) {
          if (state.stage == RenderUiStage.uploading) {
            _set(state.copyWith(upload: progress));
          }
        },
        isCancelled: () => _cancelRequested,
      );
      _throwIfCancelled();

      _set(state.copyWith(stage: RenderUiStage.submitting));

      final request = RenderRequest.fromProject(project, sizesByAssetId: sizes);
      final job = await _api.submitRender(request);
      _throwIfCancelled();

      await storage.saveActiveRenderJob(
        projectId: project.id,
        jobId: job.jobId,
      );
      _applyJob(job);
      if (job.isActive) unawaited(_poll(job.jobId));
    } on MediaUploadCancelled {
      _set(
        state.copyWith(
          stage: RenderUiStage.cancelled,
          cancelling: false,
          error: null,
        ),
      );
    } on MediaUploadException catch (e) {
      _fail(
        RenderError(
          code: 'UPLOAD_FAILED',
          message: e.message,
          retryable: e.retryable,
        ),
      );
    } on RenderApiException catch (e) {
      _fail(e.error);
    } on RenderRequestException catch (e) {
      _fail(RenderError(code: 'PLAN_INVALID', message: e.message));
    }
  }

  /// Повтор после ошибки или отмены — сервер создаст новую задачу (§5.3).
  Future<void> retry() async {
    if (state.isBusy) return;
    await ref.read(storageServiceProvider).clearActiveRenderJob();
    _set(const RenderUiState());
    await start();
  }

  /// Кооперативная отмена: до отправки — локально, после — через API.
  Future<void> cancel() async {
    if (!state.canCancel) return;
    _cancelRequested = true;
    _set(state.copyWith(cancelling: true));

    final job = state.job;
    if (job == null) {
      // Отмена во время загрузки материалов: сценарий остановит сам загрузчик.
      return;
    }

    try {
      final cancelled = await _api.cancelJob(job.jobId);
      _applyJob(cancelled);
      if (cancelled.isActive) unawaited(_poll(cancelled.jobId));
    } on RenderApiException catch (e) {
      _set(state.copyWith(cancelling: false, error: e.error));
    }
  }

  /// Запрашивает свежий signed URL результата.
  ///
  /// Ссылка живёт около часа, поэтому её всегда берут заново, а не из
  /// сохранённого состояния задачи.
  Future<RenderDownload?> requestDownload() async {
    final job = state.job;
    if (job == null || !job.isSucceeded) return null;

    _set(state.copyWith(preparingDownload: true));
    try {
      return await _api.fetchDownload(job.jobId);
    } on RenderApiException catch (e) {
      final expired = e.code == 'RESULT_EXPIRED' || e.statusCode == 410;
      _set(
        state.copyWith(
          stage: expired ? RenderUiStage.failed : state.stage,
          error: expired
              ? RenderError(
                  code: e.code,
                  message:
                      'Срок хранения результата истёк. '
                      'Запустите рендер заново.',
                )
              : e.error,
        ),
      );
      return null;
    } finally {
      _set(state.copyWith(preparingDownload: false));
    }
  }

  /// Возвращает сценарий к исходному состоянию (после скачивания/нового плана).
  Future<void> reset() async {
    _pollGeneration++;
    _wakePoll();
    _cancelRequested = false;
    await ref.read(storageServiceProvider).clearActiveRenderJob();
    _set(const RenderUiState());
  }

  // --- Поллинг -------------------------------------------------------------

  Future<void> _poll(String jobId) async {
    final generation = ++_pollGeneration;
    final config = _pollConfig;
    var interval = config.initial;
    var errors = 0;
    final deadline = DateTime.now().add(config.overallTimeout);

    while (!_disposed && generation == _pollGeneration) {
      await _sleep(interval);
      if (_disposed || generation != _pollGeneration) return;

      if (DateTime.now().isAfter(deadline)) {
        _fail(
          const RenderError(
            code: 'CLIENT_POLL_TIMEOUT',
            message:
                'Рендер идёт слишком долго. Проверьте статус позже или '
                'запустите задачу заново.',
            retryable: true,
          ),
        );
        return;
      }

      try {
        final previous = state.job;
        final job = await _api.fetchJob(jobId);
        if (_disposed || generation != _pollGeneration) return;
        errors = 0;

        _applyJob(job);
        if (job.isTerminal) return;

        // Пока состояние не меняется — опрашиваем реже (§8).
        final changed =
            previous == null ||
            previous.progress != job.progress ||
            previous.phase != job.phase ||
            previous.status != job.status;
        interval = changed ? config.initial : config.nextInterval(interval);
      } on RenderApiException catch (e) {
        if (_disposed || generation != _pollGeneration) return;
        if (!e.retryable && e.code != 'CLIENT_ERROR') {
          _fail(e.error);
          return;
        }
        errors++;
        if (errors >= config.maxConsecutiveErrors) {
          _fail(
            RenderError(
              code: e.code,
              message:
                  'Потеряна связь с сервером рендера. '
                  'Статус задачи можно обновить позже.',
              retryable: true,
              jobId: jobId,
            ),
          );
          return;
        }
        interval = config.nextInterval(interval);
      }
    }
  }

  /// Переводит состояние UI по актуальной задаче.
  ///
  /// Готовность MP4 объявляется только при терминальном успехе с результатом.
  void _applyJob(RenderJob job) {
    final stage = switch (job.status) {
      RenderStatus.succeeded when job.result != null => RenderUiStage.ready,
      // Успех без результата — сервер ещё не дописал ссылку: не врём про готовность.
      RenderStatus.succeeded => RenderUiStage.rendering,
      RenderStatus.failed => RenderUiStage.failed,
      RenderStatus.cancelled => RenderUiStage.cancelled,
      RenderStatus.queued || RenderStatus.running => RenderUiStage.rendering,
    };

    _set(
      state.copyWith(
        stage: stage,
        job: job,
        cancelling: job.isTerminal ? false : state.cancelling,
        error: job.error ?? (job.isTerminal ? null : state.error),
      ),
    );

    if (job.isTerminal) {
      _pollGeneration++;
      _wakePoll();
      if (!job.isSucceeded) {
        unawaited(ref.read(storageServiceProvider).clearActiveRenderJob());
      }
    }
  }

  void _fail(RenderError error) {
    _pollGeneration++;
    _wakePoll();
    _set(
      state.copyWith(
        stage: RenderUiStage.failed,
        error: error,
        cancelling: false,
      ),
    );
  }

  void _throwIfCancelled() {
    if (_cancelRequested) throw const MediaUploadCancelled();
  }
}
