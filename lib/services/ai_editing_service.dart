import 'package:uuid/uuid.dart';

import '../core/media_validation.dart';
import '../models/edit_plan.dart';
import '../models/edit_request.dart';
import '../models/enums.dart';
import '../models/transition.dart';
import '../models/export_settings.dart';
import '../models/media_asset.dart';
import '../models/upload_ticket.dart' show UploadProgress;

/// Наибольшая сторона среди исходников — прокси максимально доступного
/// вертикального разрешения для экспорта. `null`, если размеры неизвестны.
int? sourceMaxHeightOf(List<MediaAsset> assets) {
  int? best;
  for (final a in assets) {
    final side = a.maxSide;
    if (side != null && (best == null || side > best)) best = side;
  }
  return best;
}

/// Этап планирования, о котором сервис сообщает наружу.
enum ProcessingPhase {
  /// Прямая загрузка исходников в хранилище (прогресс по переданным байтам).
  uploading,

  /// AI-анализ загруженных материалов (серверные phase/fraction).
  analyzing,
}

/// Прогресс планирования для экрана обработки.
///
/// Два этапа не смешиваются: у загрузки — реальный побайтовый [upload], у
/// анализа — серверные [analysisPhase]/[analysisFraction]. Мок и v1 сообщают
/// только «анализируем»: у них нет отдельной загрузки в бакет.
class ProcessingProgress {
  const ProcessingProgress.uploading(this.upload)
    : phase = ProcessingPhase.uploading,
      analysisPhase = '',
      analysisMessage = '',
      analysisFraction = 0;

  const ProcessingProgress.analyzing({
    this.analysisPhase = '',
    this.analysisMessage = '',
    this.analysisFraction = 0,
  }) : phase = ProcessingPhase.analyzing,
       upload = UploadProgress.empty;

  final ProcessingPhase phase;

  /// Осмысленно на этапе [ProcessingPhase.uploading].
  final UploadProgress upload;

  /// Серверный идентификатор фазы анализа (для журналирования/отладки).
  final String analysisPhase;

  /// Человеческое описание фазы анализа (показываем пользователю).
  final String analysisMessage;

  /// Доля анализа 0..1, как её отдаёт сервер.
  final double analysisFraction;
}

/// Приёмник прогресса планирования. По умолчанию — no-op (для вызовов без UI).
typedef ProcessingReporter = void Function(ProcessingProgress progress);

/// Абстракция AI-планировщика монтажа.
///
/// UI зависит только от этого интерфейса. Позднее реализацию легко заменить
/// на настоящий HTTP-клиент к серверному API без изменения экранов.
abstract class AiEditingService {
  /// [onProgress] — необязательный приёмник этапов загрузки и анализа. Вызовы
  /// без UI могут его не передавать; сервисы без реальной загрузки сообщают
  /// только этап анализа.
  Future<EditPlan> createEditPlan(
    EditRequest request, {
    ProcessingReporter? onProgress,
  });

  /// Отменяет текущий запрос. Для мока — no-op.
  void cancel() {}

  /// Работает ли сервис в демо-режиме (без настоящего Gemini).
  bool get isDemo => true;
}

/// Ошибка планировщика с сообщением на русском языке для пользователя.
class AiEditingException implements Exception {
  const AiEditingException(this.message);
  final String message;

  @override
  String toString() => message;
}

/// Мок-реализация: строит детерминированный план из выбранных материалов.
///
/// Не обращается в сеть и не загружает пользовательские файлы.
class MockAiEditingService implements AiEditingService {
  const MockAiEditingService({this.uuid = const Uuid()});

  final Uuid uuid;

  static const double _minClip = 1.0;

  @override
  bool get isDemo => true;

  @override
  void cancel() {}

  @override
  Future<EditPlan> createEditPlan(
    EditRequest request, {
    ProcessingReporter? onProgress,
  }) async {
    // У мока нет реальной загрузки — сообщаем только этап анализа, чтобы экран
    // обработки показал корректный этап, а не пустоту.
    onProgress?.call(
      const ProcessingProgress.analyzing(
        analysisPhase: 'analyzing',
        analysisMessage: 'Собираем ролик',
      ),
    );
    // Небольшая задержка имитирует сетевой вызов; основная анимация прогресса
    // живёт на экране обработки, чтобы не запускать два процесса сразу.
    await Future<void>.delayed(const Duration(milliseconds: 250));

    final target = MediaLimits.clampOutputSeconds(request.durationSeconds);
    final clips = _buildClips(request.assets, target, request.style);
    final export = ExportResolver.build(
      choice: ExportResolution.maximumAvailable,
      durationSeconds: target,
      sourceMaxHeight: sourceMaxHeightOf(request.assets),
    );

    return EditPlan(
      id: uuid.v4(),
      prompt: request.prompt,
      style: request.style,
      durationSeconds: target,
      captions: request.captions,
      audio: request.audio,
      clips: clips,
      coverClipId: clips.isNotEmpty ? clips.first.id : null,
      export: export,
    );
  }

  List<EditClip> _buildClips(
    List<MediaAsset> assets,
    int target,
    EditStyle style,
  ) {
    if (assets.isEmpty) return const [];

    // Первичное распределение длительности.
    final base = target / assets.length;
    final rawDurations = <double>[];
    for (final asset in assets) {
      if (asset.type == MediaType.video) {
        final source = asset.durationSeconds ?? base;
        rawDurations.add(base.clamp(_minClip, source).toDouble());
      } else {
        rawDurations.add(base.clamp(1.5, 4.0).toDouble());
      }
    }

    // Масштабируем, чтобы сумма совпала с целевой длительностью.
    final rawTotal = rawDurations.fold<double>(0, (s, d) => s + d);
    final scale = rawTotal > 0 ? target / rawTotal : 1.0;
    final scaled = rawDurations
        .map((d) => (d * scale).clamp(0.5, target.toDouble()).toDouble())
        .toList();

    final clips = <EditClip>[];
    var used = 0.0;
    for (var i = 0; i < assets.length; i++) {
      final asset = assets[i];
      var duration = double.parse(scaled[i].toStringAsFixed(1));

      // Гарантируем, что итог не превысит целевую длительность.
      final remaining = target - used;
      if (duration > remaining) duration = remaining;
      if (duration < 0.5) {
        // Не осталось бюджета — оставшиеся материалы не попадают в ролик.
        break;
      }

      final isVideo = asset.type == MediaType.video;
      clips.add(
        EditClip(
          id: uuid.v4(),
          filePath: asset.path,
          type: asset.type,
          duration: duration,
          start: isVideo ? _pickStart(asset, duration) : null,
          end: isVideo ? _pickStart(asset, duration) + duration : null,
          transition: TransitionSpec(
            type: i == 0
                ? TransitionType.cut
                : TransitionType.fromStorage(style.defaultTransition),
          ),
          sourceName: asset.name,
          // Рендер адресует исходники только по mediaId (контракт §2).
          mediaId: asset.id,
        ),
      );
      used += duration;
    }

    return clips;
  }

  /// Детерминированно выбирает точку начала внутри исходного видео,
  /// имитируя выбор «лучшего момента».
  double _pickStart(MediaAsset asset, double clipDuration) {
    final source = asset.durationSeconds ?? clipDuration;
    final slack = source - clipDuration;
    if (slack <= 0) return 0;
    // Берём фрагмент из первой трети — «сильное» начало.
    return double.parse((slack * 0.25).toStringAsFixed(1));
  }
}
