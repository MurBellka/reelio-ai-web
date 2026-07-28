import 'enums.dart';
import 'export_settings.dart';

/// Настройки субтитров в монтажном плане.
class CaptionSettings {
  const CaptionSettings({
    required this.enabled,
    required this.language,
    required this.style,
    required this.colorHex,
    required this.sampleText,
  });

  final bool enabled;
  final String language;
  final CaptionStyle style;

  /// Цвет текста субтитров в формате `#RRGGBB`.
  final String colorHex;

  /// Демонстрационный текст субтитра.
  final String sampleText;

  static const CaptionSettings defaults = CaptionSettings(
    enabled: true,
    language: 'ru',
    style: CaptionStyle.bold,
    colorHex: '#FFFFFF',
    sampleText: 'Лучшие моменты твоей истории',
  );

  CaptionSettings copyWith({
    bool? enabled,
    String? language,
    CaptionStyle? style,
    String? colorHex,
    String? sampleText,
  }) => CaptionSettings(
    enabled: enabled ?? this.enabled,
    language: language ?? this.language,
    style: style ?? this.style,
    colorHex: colorHex ?? this.colorHex,
    sampleText: sampleText ?? this.sampleText,
  );

  Map<String, dynamic> toJson() => {
    'enabled': enabled,
    'language': language,
    'style': style.storageValue,
    'colorHex': colorHex,
    'sampleText': sampleText,
  };

  factory CaptionSettings.fromJson(Map<String, dynamic> json) =>
      CaptionSettings(
        enabled: json['enabled'] as bool? ?? true,
        language: json['language'] as String? ?? 'ru',
        style: CaptionStyle.fromStorage(json['style'] as String? ?? 'bold'),
        colorHex: json['colorHex'] as String? ?? '#FFFFFF',
        sampleText:
            json['sampleText'] as String? ??
            CaptionSettings.defaults.sampleText,
      );
}

/// Настройки звука в монтажном плане (контракт v2 §1).
///
/// Фоновая музыка убрана из продукта целиком: трендовый трек пользователь
/// добавляет уже в Instagram поверх готового ролика. Поэтому единственный
/// переключатель — сохранять ли оригинальный звук исходников.
class AudioSettings {
  const AudioSettings({this.keepOriginal = true});

  /// `true` — оригинальные дорожки склеиваются и нормализуются; `false` —
  /// MP4 экспортируется вообще без аудиопотока.
  final bool keepOriginal;

  static const AudioSettings defaults = AudioSettings(keepOriginal: true);

  AudioSettings copyWith({bool? keepOriginal}) =>
      AudioSettings(keepOriginal: keepOriginal ?? this.keepOriginal);

  Map<String, dynamic> toJson() => {'keepOriginal': keepOriginal};

  /// Разбирает `audio` из v2. Терпимо к отсутствию секции (старые черновики,
  /// где было только устаревшее `music`): по умолчанию оригинальный звук
  /// сохраняется.
  factory AudioSettings.fromJson(Map<String, dynamic>? json) =>
      AudioSettings(keepOriginal: json?['keepOriginal'] as bool? ?? true);
}

/// Один фрагмент монтажного плана.
class EditClip {
  const EditClip({
    required this.id,
    required this.filePath,
    required this.type,
    required this.duration,
    required this.transition,
    this.start,
    this.end,
    this.sourceName = '',
    this.mediaId = '',
    this.reason = '',
  });

  final String id;
  final String filePath;
  final MediaType type;

  /// Идентификатор исходного материала (используется backend/Gemini).
  final String mediaId;

  /// Пояснение AI, почему выбран этот фрагмент (не показывается как reasoning,
  /// служит короткой подписью в редакторе).
  final String reason;

  /// Длительность фрагмента на таймлайне (сек).
  final double duration;

  /// Начало обрезки внутри исходника (сек).
  final double? start;

  /// Конец обрезки внутри исходника (сек).
  final double? end;

  final String transition;

  /// Имя исходного файла для отображения в редакторе.
  final String sourceName;

  /// Проставляет ссылку на материал, если она потерялась (старые черновики).
  EditClip withMediaId(String value) => value == mediaId
      ? this
      : EditClip(
          id: id,
          filePath: filePath,
          type: type,
          duration: duration,
          transition: transition,
          start: start,
          end: end,
          sourceName: sourceName,
          mediaId: value,
          reason: reason,
        );

  EditClip copyWith({double? duration, String? transition}) => EditClip(
    id: id,
    filePath: filePath,
    type: type,
    duration: duration ?? this.duration,
    transition: transition ?? this.transition,
    start: start,
    end: end,
    sourceName: sourceName,
    mediaId: mediaId,
    reason: reason,
  );

  Map<String, dynamic> toJson() => {
    'id': id,
    'filePath': filePath,
    'type': type.storageValue,
    'duration': duration,
    'start': start,
    'end': end,
    'transition': transition,
    'sourceName': sourceName,
    if (mediaId.isNotEmpty) 'mediaId': mediaId,
    if (reason.isNotEmpty) 'reason': reason,
  };

  factory EditClip.fromJson(Map<String, dynamic> json) => EditClip(
    id: json['id'] as String,
    filePath: json['filePath'] as String,
    type: MediaType.fromStorage(json['type'] as String),
    duration: (json['duration'] as num).toDouble(),
    start: (json['start'] as num?)?.toDouble(),
    end: (json['end'] as num?)?.toDouble(),
    transition: json['transition'] as String? ?? 'cut',
    sourceName: json['sourceName'] as String? ?? '',
    mediaId: json['mediaId'] as String? ?? '',
    reason: json['reason'] as String? ?? '',
  );
}

/// Детерминированный монтажный план — единственный вход рендера.
class EditPlan {
  const EditPlan({
    required this.id,
    required this.prompt,
    required this.style,
    required this.durationSeconds,
    required this.captions,
    required this.audio,
    required this.clips,
    this.coverClipId,
    this.export = ExportSettings.defaults,
  });

  final String id;
  final String prompt;
  final EditStyle style;
  final int durationSeconds;
  final CaptionSettings captions;
  final AudioSettings audio;
  final List<EditClip> clips;

  /// Идентификатор клипа, выбранного как обложка.
  final String? coverClipId;

  /// Параметры экспорта (разрешение, fps, оценка размера).
  final ExportSettings export;

  /// Фактическая длительность как сумма фрагментов.
  double get computedDuration =>
      clips.fold<double>(0, (sum, clip) => sum + clip.duration);

  EditPlan copyWith({
    List<EditClip>? clips,
    CaptionSettings? captions,
    AudioSettings? audio,
    String? coverClipId,
    ExportSettings? export,
  }) => EditPlan(
    id: id,
    prompt: prompt,
    style: style,
    durationSeconds: durationSeconds,
    captions: captions ?? this.captions,
    audio: audio ?? this.audio,
    clips: clips ?? this.clips,
    coverClipId: coverClipId ?? this.coverClipId,
    export: export ?? this.export,
  );

  Map<String, dynamic> toJson() => {
    'id': id,
    'prompt': prompt,
    'style': style.storageValue,
    'durationSeconds': durationSeconds,
    'captions': captions.toJson(),
    'audio': audio.toJson(),
    'coverClipId': coverClipId,
    'export': export.toJson(),
    'clips': clips.map((c) => c.toJson()).toList(),
  };

  factory EditPlan.fromJson(Map<String, dynamic> json) => EditPlan(
    id: json['id'] as String,
    prompt: json['prompt'] as String? ?? '',
    style: EditStyle.fromStorage(json['style'] as String? ?? 'dynamicStyle'),
    durationSeconds: (json['durationSeconds'] as num?)?.toInt() ?? 30,
    captions: CaptionSettings.fromJson(
      (json['captions'] as Map).cast<String, dynamic>(),
    ),
    audio: AudioSettings.fromJson(
      (json['audio'] as Map?)?.cast<String, dynamic>(),
    ),
    coverClipId: json['coverClipId'] as String?,
    export: json['export'] == null
        ? ExportSettings.defaults
        : ExportSettings.fromJson(
            (json['export'] as Map).cast<String, dynamic>(),
          ),
    clips: (json['clips'] as List)
        .map((e) => EditClip.fromJson((e as Map).cast<String, dynamic>()))
        .toList(),
  );
}
