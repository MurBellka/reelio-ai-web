import 'font_catalog.dart';
import 'text_overlay.dart';

/// Готовый шаблон текста — набор стилевых полей, из которого одним касанием
/// создаётся оформленный [TextOverlay]. Девять пресетов покрывают типовые
/// задачи: заголовок, подпись, акцент и т. п.
enum TextTemplate {
  headline(
    'headline',
    'Заголовок',
    'Крупно',
    FontFamilyId.montserrat,
    TextWeight.bold,
    0.075,
    '#FFFFFF',
    TextAlignH.center,
    TextAnchor.top,
    TextAnimation.pop,
  ),
  subtitle(
    'subtitle',
    'Подзаголовок',
    'Мягко',
    FontFamilyId.manrope,
    TextWeight.medium,
    0.045,
    '#FFFFFF',
    TextAlignH.center,
    TextAnchor.bottom,
    TextAnimation.fade,
  ),
  neon(
    'neon',
    'Неон',
    'Ярко',
    FontFamilyId.unbounded,
    TextWeight.bold,
    0.06,
    '#C4B5FD',
    TextAlignH.center,
    TextAnchor.center,
    TextAnimation.pop,
  ),
  minimal(
    'minimal',
    'Минимал',
    'Чисто',
    FontFamilyId.inter,
    TextWeight.regular,
    0.04,
    '#FFFFFF',
    TextAlignH.left,
    TextAnchor.top,
    TextAnimation.none,
  ),
  accent(
    'accent',
    'Акцент',
    'Лайм',
    FontFamilyId.oswald,
    TextWeight.bold,
    0.065,
    '#C4F82A',
    TextAlignH.center,
    TextAnchor.center,
    TextAnimation.slide,
  ),
  retro(
    'retro',
    'Ретро',
    'Тепло',
    FontFamilyId.pacifico,
    TextWeight.regular,
    0.06,
    '#FFE066',
    TextAlignH.center,
    TextAnchor.center,
    TextAnimation.fade,
  ),
  boldCenter(
    'boldCenter',
    'Жирный центр',
    'Плашка',
    FontFamilyId.roboto,
    TextWeight.bold,
    0.07,
    '#FFFFFF',
    TextAlignH.center,
    TextAnchor.center,
    TextAnimation.fade,
  ),
  caption(
    'caption',
    'Подпись',
    'Внизу',
    FontFamilyId.ptSans,
    TextWeight.medium,
    0.038,
    '#FFFFFF',
    TextAlignH.center,
    TextAnchor.bottom,
    TextAnimation.none,
  ),
  handwritten(
    'handwritten',
    'От руки',
    'Живо',
    FontFamilyId.caveat,
    TextWeight.bold,
    0.07,
    '#FFFFFF',
    TextAlignH.center,
    TextAnchor.center,
    TextAnimation.slide,
  );

  const TextTemplate(
    this.storageValue,
    this.label,
    this.hint,
    this.fontId,
    this.weight,
    this.fontSizeRatio,
    this.colorHex,
    this.align,
    this.anchor,
    this.animation,
  );

  final String storageValue;
  final String label;
  final String hint;
  final FontFamilyId fontId;
  final TextWeight weight;
  final double fontSizeRatio;
  final String colorHex;
  final TextAlignH align;
  final TextAnchor anchor;
  final TextAnimation animation;

  /// Оформление, отличающее шаблоны сверх шрифта и цвета: плашка/обводка/тень.
  TextBackground? get background => switch (this) {
    TextTemplate.boldCenter => const TextBackground(opacity: 0.5),
    TextTemplate.caption => const TextBackground(opacity: 0.4),
    _ => null,
  };

  TextOutline? get outline => switch (this) {
    TextTemplate.neon => const TextOutline(
      colorHex: '#4C1D95',
      widthRatio: 0.006,
    ),
    TextTemplate.retro => const TextOutline(widthRatio: 0.005),
    _ => null,
  };

  TextShadowSpec? get shadow => switch (this) {
    TextTemplate.headline ||
    TextTemplate.accent ||
    TextTemplate.handwritten => const TextShadowSpec(),
    _ => null,
  };

  /// Собирает оформленный слой. Позиция по умолчанию — из якоря шаблона,
  /// прижатая к безопасной зоне (§4.2).
  TextOverlay build({required String id, required String text}) => TextOverlay(
    id: id,
    text: text,
    anchor: anchor,
    x: 0.5,
    y: ReelsSafeZone.clampY(anchor.defaultY),
    fontId: fontId,
    fontWeight: weight,
    fontSizeRatio: fontSizeRatio,
    colorHex: colorHex,
    align: align,
    animation: animation,
    background: background,
    outline: outline,
    shadow: shadow,
  );
}
