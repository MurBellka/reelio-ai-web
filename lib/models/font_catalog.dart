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
  inter('inter', 'Inter', FontGroup.modern),
  montserrat('montserrat', 'Montserrat', FontGroup.modern),
  manrope('manrope', 'Manrope', FontGroup.modern),
  roboto('roboto', 'Roboto', FontGroup.strict),
  ptSans('pt_sans', 'PT Sans', FontGroup.strict),
  oswald('oswald', 'Oswald', FontGroup.emotional),
  unbounded('unbounded', 'Unbounded', FontGroup.emotional),
  caveat('caveat', 'Caveat', FontGroup.decorative),
  pacifico('pacifico', 'Pacifico', FontGroup.decorative);

  const FontFamilyId(this.storageValue, this.label, this.group);

  /// Значение поля `fontId` в плане (§5).
  final String storageValue;
  final String label;
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
