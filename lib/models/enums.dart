import 'package:flutter/material.dart';

/// Тип исходного материала.
enum MediaType {
  video,
  photo;

  String get storageValue => name;

  static MediaType fromStorage(String value) => MediaType.values.firstWhere(
    (e) => e.name == value,
    orElse: () => MediaType.video,
  );
}

/// Стиль монтажа.
enum EditStyle {
  dynamicStyle(
    'Динамичный',
    'Быстрые склейки, высокий темп',
    Icons.bolt_rounded,
  ),
  cinematic(
    'Кинематографичный',
    'Плавные переходы, глубина кадра',
    Icons.movie_filter_rounded,
  ),
  calm('Спокойный', 'Мягкий ритм, длинные планы', Icons.spa_rounded),
  minimal(
    'Минималистичный',
    'Чистый монтаж без лишнего',
    Icons.crop_square_rounded,
  );

  const EditStyle(this.label, this.description, this.icon);

  final String label;
  final String description;
  final IconData icon;

  String get storageValue => name;

  /// Предпочитаемый переход для стиля.
  String get defaultTransition => switch (this) {
    EditStyle.dynamicStyle => 'slide',
    EditStyle.cinematic => 'crossfade',
    EditStyle.calm => 'fade',
    EditStyle.minimal => 'cut',
  };

  static EditStyle fromStorage(String value) => EditStyle.values.firstWhere(
    (e) => e.name == value,
    orElse: () => EditStyle.dynamicStyle,
  );
}

/// Музыкальные пресеты внутреннего каталога.
enum MusicTrack {
  none('Без музыки', 0, Icons.music_off_rounded),
  chill('Chill', 92, Icons.nightlight_round),
  energy('Energy', 128, Icons.local_fire_department_rounded),
  cinematic('Cinematic', 80, Icons.theaters_rounded),
  trending('Trending', 120, Icons.trending_up_rounded);

  const MusicTrack(this.label, this.bpm, this.icon);

  final String label;
  final int bpm;
  final IconData icon;

  bool get hasAudio => this != MusicTrack.none;

  String get storageValue => name;

  static MusicTrack fromStorage(String value) => MusicTrack.values.firstWhere(
    (e) => e.name == value,
    orElse: () => MusicTrack.none,
  );
}

/// Стиль отображения субтитров.
enum CaptionStyle {
  clean('Чистый'),
  bold('Жирный'),
  karaoke('Караоке');

  const CaptionStyle(this.label);
  final String label;

  String get storageValue => name;

  static CaptionStyle fromStorage(String value) => CaptionStyle.values
      .firstWhere((e) => e.name == value, orElse: () => CaptionStyle.clean);
}

/// Варианты разрешения вертикального (9:16) экспорта.
enum ExportResolution {
  hd720('720p', 720, 1280),
  fullHd1080('Full HD', 1080, 1920),
  twoK1440('2K', 1440, 2560),
  fourK2160('4K', 2160, 3840),

  /// Особое значение: подобрать максимально доступное качество по исходникам.
  maximumAvailable('Максимальное', 0, 0);

  const ExportResolution(this.label, this.width, this.height);

  final String label;

  /// Ширина/высота вертикального кадра 9:16. Для [maximumAvailable] — 0,
  /// фактические значения вычисляются из исходных материалов.
  final int width;
  final int height;

  bool get isAuto => this == ExportResolution.maximumAvailable;

  /// Короткая подпись `1080×1920`.
  String get dimensionsLabel => isAuto ? 'авто' : '$width×$height';

  /// Все конкретные (не авто) варианты по возрастанию высоты.
  static List<ExportResolution> get concrete => const [
    ExportResolution.hd720,
    ExportResolution.fullHd1080,
    ExportResolution.twoK1440,
    ExportResolution.fourK2160,
  ];

  String get storageValue => name;

  static ExportResolution fromStorage(String value) =>
      ExportResolution.values.firstWhere(
        (e) => e.name == value,
        orElse: () => ExportResolution.maximumAvailable,
      );
}

/// Основные этапы пользовательского сценария.
enum AppStage {
  onboarding('Старт'),
  upload('Материалы'),
  settings('Настройки'),
  processing('Обработка'),
  preview('Предпросмотр'),
  editor('Правки'),
  export('Экспорт');

  const AppStage(this.label);
  final String label;

  AppStage? get next {
    final i = index;
    return i < AppStage.values.length - 1 ? AppStage.values[i + 1] : null;
  }

  AppStage? get previous {
    final i = index;
    return i > 0 ? AppStage.values[i - 1] : null;
  }

  String get storageValue => name;

  static AppStage fromStorage(String value) => AppStage.values.firstWhere(
    (e) => e.name == value,
    orElse: () => AppStage.onboarding,
  );
}
