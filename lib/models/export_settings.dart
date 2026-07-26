import 'dart:math' as math;

import 'enums.dart';

/// Итоговые параметры экспорта, попадающие в монтажный план и render job.
class ExportSettings {
  const ExportSettings({
    required this.resolution,
    required this.width,
    required this.height,
    required this.fps,
    required this.estimatedSizeBytes,
    required this.isUpscale,
  });

  /// Выбор пользователя (может быть [ExportResolution.maximumAvailable]).
  final ExportResolution resolution;

  /// Фактические ширина/высота вертикального кадра 9:16 после разрешения выбора.
  final int width;
  final int height;
  final int fps;
  final int estimatedSizeBytes;

  /// Выбранное разрешение выше исходного материала (апскейл без новых деталей).
  final bool isUpscale;

  static const ExportSettings defaults = ExportSettings(
    resolution: ExportResolution.maximumAvailable,
    width: 1080,
    height: 1920,
    fps: 30,
    estimatedSizeBytes: 0,
    isUpscale: false,
  );

  ExportSettings copyWith({
    ExportResolution? resolution,
    int? width,
    int? height,
    int? fps,
    int? estimatedSizeBytes,
    bool? isUpscale,
  }) => ExportSettings(
    resolution: resolution ?? this.resolution,
    width: width ?? this.width,
    height: height ?? this.height,
    fps: fps ?? this.fps,
    estimatedSizeBytes: estimatedSizeBytes ?? this.estimatedSizeBytes,
    isUpscale: isUpscale ?? this.isUpscale,
  );

  Map<String, dynamic> toJson() => {
    'resolution': resolution.storageValue,
    'width': width,
    'height': height,
    'fps': fps,
    'estimatedSizeBytes': estimatedSizeBytes,
    'isUpscale': isUpscale,
  };

  factory ExportSettings.fromJson(Map<String, dynamic> json) => ExportSettings(
    resolution: ExportResolution.fromStorage(
      json['resolution'] as String? ?? 'maximumAvailable',
    ),
    width: (json['width'] as num?)?.toInt() ?? 1080,
    height: (json['height'] as num?)?.toInt() ?? 1920,
    fps: (json['fps'] as num?)?.toInt() ?? 30,
    estimatedSizeBytes: (json['estimatedSizeBytes'] as num?)?.toInt() ?? 0,
    isUpscale: json['isUpscale'] as bool? ?? false,
  );
}

/// Чистая логика подбора и оценки экспортного разрешения. Без Flutter — тестируемо.
class ExportResolver {
  const ExportResolver._();

  static const int defaultFps = 30;

  /// Разрешает выбор в конкретное разрешение с учётом исходников.
  ///
  /// Для [ExportResolution.maximumAvailable] берёт наибольшее конкретное
  /// разрешение, не превышающее исходное (чтобы не апскейлить по умолчанию).
  static ExportResolution resolveConcrete(
    ExportResolution choice,
    int? sourceMaxHeight,
  ) {
    if (!choice.isAuto) return choice;
    if (sourceMaxHeight == null || sourceMaxHeight <= 0) {
      return ExportResolution.fullHd1080;
    }
    var best = ExportResolution.hd720;
    for (final r in ExportResolution.concrete) {
      if (r.height <= sourceMaxHeight) best = r;
    }
    return best;
  }

  /// Является ли конкретное разрешение апскейлом относительно исходников.
  static bool isUpscale(ExportResolution concrete, int? sourceMaxHeight) {
    if (concrete.isAuto) return false;
    if (sourceMaxHeight == null || sourceMaxHeight <= 0) return false;
    return concrete.height > sourceMaxHeight;
  }

  /// Оценка размера файла (байты). База ~10 Мбит/с на 1080×1920, масштаб по
  /// площади кадра. Это оценка, а не гарантия итогового размера.
  static int estimateSizeBytes({
    required int height,
    required int durationSeconds,
    int fps = defaultFps,
  }) {
    const baseBitrate = 10e6; // бит/с при height=1920
    final factor = math.pow(height / 1920, 1.5).toDouble();
    final fpsFactor = fps / 30.0;
    final bits = baseBitrate * factor * fpsFactor * durationSeconds;
    return (bits / 8).round();
  }

  /// Собирает [ExportSettings] по выбору пользователя.
  static ExportSettings build({
    required ExportResolution choice,
    required int durationSeconds,
    int? sourceMaxHeight,
    int fps = defaultFps,
  }) {
    final concrete = resolveConcrete(choice, sourceMaxHeight);
    return ExportSettings(
      resolution: choice,
      width: concrete.width,
      height: concrete.height,
      fps: fps,
      estimatedSizeBytes: estimateSizeBytes(
        height: concrete.height,
        durationSeconds: durationSeconds,
        fps: fps,
      ),
      isUpscale: choice.isAuto ? false : isUpscale(concrete, sourceMaxHeight),
    );
  }
}
