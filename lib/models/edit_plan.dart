import 'enums.dart';
import 'export_settings.dart';
import 'text_overlay.dart';
import 'transition.dart';

/// Контролируемая ошибка разбора плана: сервер прислал структуру, не
/// соответствующую контракту v2. Бросается вместо сырого Dart type-cast, чтобы
/// UI показал понятное состояние, а не падал.
class EditPlanFormatException implements Exception {
  const EditPlanFormatException(this.message);
  final String message;
  @override
  String toString() => 'EditPlanFormatException: $message';
}

/// Безопасно приводит значение к double (принимает num и числовую строку).
double? _asDouble(Object? v) {
  if (v is num) return v.toDouble();
  if (v is String) return double.tryParse(v);
  return null;
}

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
///
/// Клип ссылается на исходный материал ТОЛЬКО через [mediaId] — стабильный
/// серверный идентификатор. [filePath] — необязательное клиентское обогащение
/// для предпросмотра (локальный путь текущей сессии); его нет в серверном плане,
/// он НЕ сериализуется и НЕ уходит на сервер в /render.
class EditClip {
  const EditClip({
    required this.id,
    required this.type,
    required this.duration,
    required this.transition,
    this.filePath,
    this.start,
    this.end,
    this.sourceName = '',
    this.mediaId = '',
    this.reason = '',
  });

  final String id;

  /// Локальный путь для предпросмотра (клиентское обогащение по [mediaId]).
  /// В серверном плане отсутствует; наружу не сериализуется.
  final String? filePath;
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

  /// Переход к этому клипу — полный объект контракта v2 (§2.1).
  final TransitionSpec transition;

  /// Имя исходного файла для отображения в редакторе.
  final String sourceName;

  /// Проставляет ссылку на материал, если она потерялась (старые черновики).
  EditClip withMediaId(String value) =>
      value == mediaId ? this : copyWith(mediaId: value);

  /// Клиентское обогащение локальным путём предпросмотра (по mediaId).
  EditClip withLocalPath(String? path) => copyWith(filePath: path);

  EditClip copyWith({
    double? duration,
    TransitionSpec? transition,
    String? mediaId,
    String? filePath,
  }) => EditClip(
    id: id,
    filePath: filePath ?? this.filePath,
    type: type,
    duration: duration ?? this.duration,
    transition: transition ?? this.transition,
    start: start,
    end: end,
    sourceName: sourceName,
    mediaId: mediaId ?? this.mediaId,
    reason: reason,
  );

  /// Сериализация для /render и локального черновика. `filePath` НЕ включается:
  /// сервер работает по mediaId, а локальный путь не должен утечь в запрос.
  Map<String, dynamic> toJson() => {
    'id': id,
    'type': type.storageValue,
    'duration': duration,
    'start': start,
    'end': end,
    'transition': transition.toJson(),
    if (sourceName.isNotEmpty) 'sourceName': sourceName,
    if (mediaId.isNotEmpty) 'mediaId': mediaId,
    if (reason.isNotEmpty) 'reason': reason,
  };

  factory EditClip.fromJson(Map<String, dynamic> json) {
    final id = json['id'];
    if (id is! String || id.isEmpty) {
      throw const EditPlanFormatException('клип без идентификатора');
    }
    final duration = _asDouble(json['duration']);
    if (duration == null || duration <= 0) {
      throw EditPlanFormatException('клип $id: некорректная длительность');
    }
    return EditClip(
      id: id,
      // Серверный план v2 НЕ содержит filePath — это нормально (null).
      filePath: json['filePath'] as String?,
      type: MediaType.fromStorage(json['type'] as String? ?? 'video'),
      duration: duration,
      start: _asDouble(json['start']),
      end: _asDouble(json['end']),
      // v2-объект и v1-строка — оба поддерживаются, параметры сохраняются.
      transition: TransitionSpec.fromJson(json['transition']),
      sourceName: json['sourceName'] as String? ?? '',
      mediaId: json['mediaId'] as String? ?? '',
      reason: json['reason'] as String? ?? '',
    );
  }
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
    this.textOverlays = const [],
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

  /// Текстовые слои поверх ролика (§4). До 20 элементов.
  final List<TextOverlay> textOverlays;

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
    List<TextOverlay>? textOverlays,
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
    textOverlays: textOverlays ?? this.textOverlays,
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
    'textOverlays': textOverlays.map((t) => t.toJson()).toList(),
  };

  factory EditPlan.fromJson(Map<String, dynamic> json) {
    final id = json['id'];
    if (id is! String || id.isEmpty) {
      throw const EditPlanFormatException('план без идентификатора');
    }
    final rawClips = json['clips'];
    if (rawClips is! List || rawClips.isEmpty) {
      throw const EditPlanFormatException('план без клипов');
    }
    final clips = <EditClip>[];
    for (final e in rawClips) {
      if (e is! Map) {
        throw const EditPlanFormatException('клип не является объектом');
      }
      clips.add(EditClip.fromJson(e.cast<String, dynamic>()));
    }
    final overlays = <TextOverlay>[];
    for (final e in (json['textOverlays'] as List? ?? const [])) {
      if (e is! Map) {
        throw const EditPlanFormatException(
          'текстовый слой не является объектом',
        );
      }
      overlays.add(TextOverlay.fromJson(e.cast<String, dynamic>()));
    }
    final captions = json['captions'];
    final audio = json['audio'];
    return EditPlan(
      id: id,
      prompt: json['prompt'] as String? ?? '',
      style: EditStyle.fromStorage(json['style'] as String? ?? 'dynamicStyle'),
      durationSeconds: (json['durationSeconds'] as num?)?.toInt() ?? 30,
      captions: CaptionSettings.fromJson(
        captions is Map ? captions.cast<String, dynamic>() : const {},
      ),
      audio: AudioSettings.fromJson(
        audio is Map ? audio.cast<String, dynamic>() : null,
      ),
      coverClipId: json['coverClipId'] as String?,
      export: json['export'] is Map
          ? ExportSettings.fromJson(
              (json['export'] as Map).cast<String, dynamic>(),
            )
          : ExportSettings.defaults,
      clips: clips,
      textOverlays: overlays,
    );
  }
}
