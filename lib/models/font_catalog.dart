/// Группы шрифтов каталога (контракт v2 §5) — для раскладки выбора.
enum FontGroup {
  modern('Современные'),
  strict('Строгие'),
  emotional('Эмоциональные'),
  decorative('Декоративные');

  const FontGroup(this.label);
  final String label;
}

/// Каталог проверенных open-source шрифтов с кириллицей (контракт v2 §5).
/// Один и тот же файл используется и web-превью, и FFmpeg, поэтому экспорт
/// совпадает с экраном. Здесь — только идентификаторы и метаданные; сами
/// файлы и лицензии лежат в `assets/fonts/`.
enum FontFamilyId {
  inter('inter', 'Inter', 'Inter', FontGroup.modern),
  montserrat('montserrat', 'Montserrat', 'Montserrat', FontGroup.modern),
  manrope('manrope', 'Manrope', 'Manrope', FontGroup.modern),
  roboto('roboto', 'Roboto', 'Roboto', FontGroup.strict),
  ptSans('pt_sans', 'PT Sans', 'PT Sans', FontGroup.strict),
  oswald('oswald', 'Oswald', 'Oswald', FontGroup.emotional),
  unbounded('unbounded', 'Unbounded', 'Unbounded', FontGroup.emotional),
  caveat('caveat', 'Caveat', 'Caveat', FontGroup.decorative),
  pacifico('pacifico', 'Pacifico', 'Pacifico', FontGroup.decorative);

  const FontFamilyId(this.storageValue, this.label, this.family, this.group);

  /// Значение поля `fontId` в плане (§5).
  final String storageValue;
  final String label;

  /// Имя семейства, объявленное в `pubspec.yaml` (`fonts:`) — по нему Flutter
  /// подбирает реальный файл. Совпадает с семейством, которое worker передаёт
  /// в libass, поэтому предпросмотр и MP4 используют один и тот же шрифт.
  final String family;

  final FontGroup group;

  /// Лицензия — единая для всего каталога (§5).
  String get license => 'OFL 1.1';

  /// Шрифт по умолчанию, если `fontId` не распознан (§5: «неизвестный fontId
  /// не ошибка: worker берёт inter»).
  static const FontFamilyId fallback = FontFamilyId.inter;

  static FontFamilyId fromStorage(String? value) {
    for (final f in FontFamilyId.values) {
      if (f.storageValue == value) return f;
    }
    return fallback;
  }

  /// Каталог, сгруппированный по разделам — для раскладки в редакторе.
  static Map<FontGroup, List<FontFamilyId>> get byGroup {
    final map = <FontGroup, List<FontFamilyId>>{};
    for (final f in FontFamilyId.values) {
      map.putIfAbsent(f.group, () => []).add(f);
    }
    return map;
  }
}

/// Шрифт превью субтитров. Совпадает с `DEFAULT_FONT_ID` worker'а (`inter`,
/// §6): модель субтитров пока не несёт собственный `fontId` (caption v2
/// отложен), поэтому предпросмотр использует тот же шрифт, что и экспорт, —
/// а не молчаливый системный.
const FontFamilyId kCaptionPreviewFont = FontFamilyId.inter;
