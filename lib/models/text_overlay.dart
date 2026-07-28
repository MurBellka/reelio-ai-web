import 'font_catalog.dart';

/// Вертикальная привязка текста (§4). Задаёт значение `y` по умолчанию.
enum TextAnchor {
  top('top', 0.18),
  center('center', 0.5),
  bottom('bottom', 0.80);

  const TextAnchor(this.storageValue, this.defaultY);
  final String storageValue;
  final double defaultY;

  static TextAnchor fromStorage(String? v) => TextAnchor.values.firstWhere(
    (e) => e.storageValue == v,
    orElse: () => TextAnchor.bottom,
  );
}

/// Горизонтальное выравнивание текста внутри блока (§4).
enum TextAlignH {
  left('left'),
  center('center'),
  right('right');

  const TextAlignH(this.storageValue);
  final String storageValue;

  static TextAlignH fromStorage(String? v) => TextAlignH.values.firstWhere(
    (e) => e.storageValue == v,
    orElse: () => TextAlignH.center,
  );
}

/// Начертание из статических файлов каталога (§4/§5).
enum TextWeight {
  regular('regular'),
  medium('medium'),
  bold('bold');

  const TextWeight(this.storageValue);
  final String storageValue;

  static TextWeight fromStorage(String? v) => TextWeight.values.firstWhere(
    (e) => e.storageValue == v,
    orElse: () => TextWeight.bold,
  );
}

/// Анимация появления/исчезновения текста (§4.4).
enum TextAnimation {
  none('none', 'Без анимации'),
  fade('fade', 'Проявление'),
  slide('slide', 'Выезд снизу'),
  pop('pop', 'Всплытие');

  const TextAnimation(this.storageValue, this.label);
  final String storageValue;
  final String label;

  static TextAnimation fromStorage(String? v) => TextAnimation.values
      .firstWhere((e) => e.storageValue == v, orElse: () => TextAnimation.fade);
}

/// Плашка под текстом (§4). `null` — без неё.
class TextBackground {
  const TextBackground({
    this.colorHex = '#000000',
    this.opacity = 0.45,
    this.paddingRatio = 0.02,
    this.radiusRatio = 0.01,
  });

  final String colorHex;
  final double opacity;
  final double paddingRatio;
  final double radiusRatio;

  TextBackground copyWith({String? colorHex, double? opacity}) =>
      TextBackground(
        colorHex: colorHex ?? this.colorHex,
        opacity: opacity ?? this.opacity,
        paddingRatio: paddingRatio,
        radiusRatio: radiusRatio,
      );

  Map<String, dynamic> toJson() => {
    'colorHex': colorHex,
    'opacity': opacity,
    'paddingRatio': paddingRatio,
    'radiusRatio': radiusRatio,
  };

  factory TextBackground.fromJson(Map<String, dynamic> j) => TextBackground(
    colorHex: j['colorHex'] as String? ?? '#000000',
    opacity: (j['opacity'] as num?)?.toDouble() ?? 0.45,
    paddingRatio: (j['paddingRatio'] as num?)?.toDouble() ?? 0.02,
    radiusRatio: (j['radiusRatio'] as num?)?.toDouble() ?? 0.01,
  );
}

/// Обводка текста (§4). `null` — без неё.
class TextOutline {
  const TextOutline({this.colorHex = '#000000', this.widthRatio = 0.004});

  final String colorHex;
  final double widthRatio;

  Map<String, dynamic> toJson() => {
    'colorHex': colorHex,
    'widthRatio': widthRatio,
  };

  factory TextOutline.fromJson(Map<String, dynamic> j) => TextOutline(
    colorHex: j['colorHex'] as String? ?? '#000000',
    widthRatio: (j['widthRatio'] as num?)?.toDouble() ?? 0.004,
  );
}

/// Тень текста (§4). `null` — без неё.
class TextShadowSpec {
  const TextShadowSpec({
    this.colorHex = '#000000',
    this.opacity = 0.6,
    this.offsetRatio = 0.004,
  });

  final String colorHex;
  final double opacity;
  final double offsetRatio;

  Map<String, dynamic> toJson() => {
    'colorHex': colorHex,
    'opacity': opacity,
    'offsetRatio': offsetRatio,
  };

  factory TextShadowSpec.fromJson(Map<String, dynamic> j) => TextShadowSpec(
    colorHex: j['colorHex'] as String? ?? '#000000',
    opacity: (j['opacity'] as num?)?.toDouble() ?? 0.6,
    offsetRatio: (j['offsetRatio'] as num?)?.toDouble() ?? 0.004,
  );
}

/// Безопасная зона Instagram Reels в долях кадра (§4.2). Элементы интерфейса
/// Reels перекрывают края, поэтому центр текста держим внутри этих границ.
class ReelsSafeZone {
  const ReelsSafeZone._();

  static const double top = 0.14;
  static const double bottom = 0.20;
  static const double left = 0.06;
  static const double right = 0.06;

  static double clampX(double x) => x.clamp(left, 1 - right);
  static double clampY(double y) => y.clamp(top, 1 - bottom);

  /// Находится ли центр текста внутри безопасной зоны.
  static bool contains(double x, double y) =>
      x >= left && x <= 1 - right && y >= top && y <= 1 - bottom;
}

/// Текстовый слой поверх ролика (§4). Все координаты и размеры —
/// **доли кадра**, поэтому одна и та же раскладка совпадает в 720p…4K.
class TextOverlay {
  const TextOverlay({
    required this.id,
    required this.text,
    this.startSeconds = 0.0,
    this.endSeconds = 3.0,
    this.clipId,
    this.anchor = TextAnchor.bottom,
    this.x = 0.5,
    this.y = 0.80,
    this.fontId = FontFamilyId.montserrat,
    this.fontWeight = TextWeight.bold,
    this.fontSizeRatio = 0.055,
    this.colorHex = '#FFFFFF',
    this.align = TextAlignH.center,
    this.opacity = 1.0,
    this.background,
    this.outline,
    this.shadow,
    this.animation = TextAnimation.fade,
  });

  static const int maxTextLength = 200; // §4
  static const double minFontSizeRatio = 0.02;
  static const double maxFontSizeRatio = 0.15;

  final String id;
  final String text;
  final double startSeconds;
  final double endSeconds;

  /// Если задан — время отсчитывается от клипа (§4).
  final String? clipId;

  final TextAnchor anchor;

  /// Центр текста в долях кадра: [x] от ширины, [y] от высоты.
  final double x;
  final double y;

  final FontFamilyId fontId;
  final TextWeight fontWeight;

  /// Доля ВЫСОТЫ кадра: [minFontSizeRatio]..[maxFontSizeRatio].
  final double fontSizeRatio;

  final String colorHex;
  final TextAlignH align;
  final double opacity;
  final TextBackground? background;
  final TextOutline? outline;
  final TextShadowSpec? shadow;
  final TextAnimation animation;

  /// Внутри ли центр безопасной зоны Reels (§4.2).
  bool get isInSafeZone => ReelsSafeZone.contains(x, y);

  TextOverlay copyWith({
    String? text,
    double? startSeconds,
    double? endSeconds,
    TextAnchor? anchor,
    double? x,
    double? y,
    FontFamilyId? fontId,
    TextWeight? fontWeight,
    double? fontSizeRatio,
    String? colorHex,
    TextAlignH? align,
    double? opacity,
    TextAnimation? animation,
    Object? background = _keep,
    Object? outline = _keep,
    Object? shadow = _keep,
  }) => TextOverlay(
    id: id,
    text: text ?? this.text,
    startSeconds: startSeconds ?? this.startSeconds,
    endSeconds: endSeconds ?? this.endSeconds,
    clipId: clipId,
    anchor: anchor ?? this.anchor,
    x: x == null ? this.x : x.clamp(0.0, 1.0),
    y: y == null ? this.y : y.clamp(0.0, 1.0),
    fontId: fontId ?? this.fontId,
    fontWeight: fontWeight ?? this.fontWeight,
    fontSizeRatio: fontSizeRatio == null
        ? this.fontSizeRatio
        : fontSizeRatio.clamp(minFontSizeRatio, maxFontSizeRatio),
    colorHex: colorHex ?? this.colorHex,
    align: align ?? this.align,
    opacity: opacity == null ? this.opacity : opacity.clamp(0.0, 1.0),
    background: background == _keep
        ? this.background
        : background as TextBackground?,
    outline: outline == _keep ? this.outline : outline as TextOutline?,
    shadow: shadow == _keep ? this.shadow : shadow as TextShadowSpec?,
    animation: animation ?? this.animation,
  );

  Map<String, dynamic> toJson() => {
    'id': id,
    'text': text,
    'startSeconds': startSeconds,
    'endSeconds': endSeconds,
    'clipId': clipId,
    'position': {'anchor': anchor.storageValue, 'x': x, 'y': y},
    'fontId': fontId.storageValue,
    'fontWeight': fontWeight.storageValue,
    'fontSizeRatio': fontSizeRatio,
    'colorHex': colorHex,
    'align': align.storageValue,
    'opacity': opacity,
    'background': background?.toJson(),
    'outline': outline?.toJson(),
    'shadow': shadow?.toJson(),
    'animation': animation.storageValue,
  };

  factory TextOverlay.fromJson(Map<String, dynamic> json) {
    final pos = (json['position'] as Map?)?.cast<String, dynamic>();
    final anchor = TextAnchor.fromStorage(pos?['anchor'] as String?);
    final bg = (json['background'] as Map?)?.cast<String, dynamic>();
    final ol = (json['outline'] as Map?)?.cast<String, dynamic>();
    final sh = (json['shadow'] as Map?)?.cast<String, dynamic>();
    return TextOverlay(
      id: json['id'] as String,
      text: json['text'] as String? ?? '',
      startSeconds: (json['startSeconds'] as num?)?.toDouble() ?? 0.0,
      endSeconds: (json['endSeconds'] as num?)?.toDouble() ?? 3.0,
      clipId: json['clipId'] as String?,
      anchor: anchor,
      x: (pos?['x'] as num?)?.toDouble() ?? 0.5,
      y: (pos?['y'] as num?)?.toDouble() ?? anchor.defaultY,
      fontId: FontFamilyId.fromStorage(json['fontId'] as String?),
      fontWeight: TextWeight.fromStorage(json['fontWeight'] as String?),
      fontSizeRatio: (json['fontSizeRatio'] as num?)?.toDouble() ?? 0.055,
      colorHex: json['colorHex'] as String? ?? '#FFFFFF',
      align: TextAlignH.fromStorage(json['align'] as String?),
      opacity: (json['opacity'] as num?)?.toDouble() ?? 1.0,
      background: bg == null ? null : TextBackground.fromJson(bg),
      outline: ol == null ? null : TextOutline.fromJson(ol),
      shadow: sh == null ? null : TextShadowSpec.fromJson(sh),
      animation: TextAnimation.fromStorage(json['animation'] as String?),
    );
  }

  static const Object _keep = Object();
}
