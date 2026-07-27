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

/// Настройки музыки в монтажном плане.
class MusicSettings {
  const MusicSettings({required this.track, required this.volume});

  final MusicTrack track;

  /// Громкость музыки 0..1.
  final double volume;

  static const MusicSettings defaults = MusicSettings(
    track: MusicTrack.chill,
    volume: 0.7,
  );

  MusicSettings copyWith({MusicTrack? track, double? volume}) =>
      MusicSettings(track: track ?? this.track, volume: volume ?? this.volume);

  Map<String, dynamic> toJson() => {
    'track': track.storageValue,
    'volume': volume,
  };

  factory MusicSettings.fromJson(Map<String, dynamic> json) => MusicSettings(
    track: MusicTrack.fromStorage(json['track'] as String? ?? 'chill'),
    volume: (json['volume'] as num?)?.toDouble() ?? 0.7,
  );
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
    required this.music,
    required this.clips,
    this.coverClipId,
    this.export = ExportSettings.defaults,
  });

  final String id;
  final String prompt;
  final EditStyle style;
  final int durationSeconds;
  final CaptionSettings captions;
  final MusicSettings music;
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
    MusicSettings? music,
    String? coverClipId,
    ExportSettings? export,
  }) => EditPlan(
    id: id,
    prompt: prompt,
    style: style,
    durationSeconds: durationSeconds,
    captions: captions ?? this.captions,
    music: music ?? this.music,
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
    'music': music.toJson(),
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
    music: MusicSettings.fromJson(
      (json['music'] as Map).cast<String, dynamic>(),
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
