// Каталог шрифтов (§5 контракта v2).
//
// Главное требование: web-превью и FFmpeg используют ОДИН И ТОТ ЖЕ файл, иначе
// экспорт не совпадёт с тем, что пользователь видел на экране. Поэтому файлы
// лежат в репозитории (assets/fonts/), а не подтягиваются из сети ни клиентом,
// ни образом.
//
// Все шрифты — проверенные open-source семейства Google Fonts с кириллицей;
// файлы лицензий лежат рядом со шрифтами.

/**
 * `fontId` → семейство и файлы начертаний.
 *
 * `family` обязан совпадать с внутренним именем семейства в TTF: именно по
 * нему libass находит шрифт в fontsdir.
 */
export const FONT_CATALOG = {
  inter: {
    family: 'Inter',
    group: 'modern',
    label: 'Inter',
    license: 'OFL-1.1',
    files: { regular: 'Inter-Regular.ttf', medium: 'Inter-Medium.ttf', bold: 'Inter-Bold.ttf' },
  },
  montserrat: {
    family: 'Montserrat',
    group: 'modern',
    label: 'Montserrat',
    license: 'OFL-1.1',
    files: {
      regular: 'Montserrat-Regular.ttf',
      medium: 'Montserrat-Medium.ttf',
      bold: 'Montserrat-Bold.ttf',
    },
  },
  manrope: {
    family: 'Manrope',
    group: 'modern',
    label: 'Manrope',
    license: 'OFL-1.1',
    files: { regular: 'Manrope-Regular.ttf', medium: 'Manrope-Medium.ttf', bold: 'Manrope-Bold.ttf' },
  },
  roboto: {
    family: 'Roboto',
    group: 'strict',
    label: 'Roboto',
    license: 'OFL-1.1',
    files: { regular: 'Roboto-Regular.ttf', medium: 'Roboto-Medium.ttf', bold: 'Roboto-Bold.ttf' },
  },
  pt_sans: {
    family: 'PT Sans',
    group: 'strict',
    label: 'PT Sans',
    license: 'OFL-1.1',
    files: { regular: 'PTSans-Regular.ttf', medium: 'PTSans-Bold.ttf', bold: 'PTSans-Bold.ttf' },
  },
  oswald: {
    family: 'Oswald',
    group: 'expressive',
    label: 'Oswald',
    license: 'OFL-1.1',
    files: { regular: 'Oswald-Regular.ttf', medium: 'Oswald-Medium.ttf', bold: 'Oswald-Bold.ttf' },
  },
  unbounded: {
    family: 'Unbounded',
    group: 'expressive',
    label: 'Unbounded',
    license: 'OFL-1.1',
    files: {
      regular: 'Unbounded-Regular.ttf',
      medium: 'Unbounded-Medium.ttf',
      bold: 'Unbounded-Bold.ttf',
    },
  },
  caveat: {
    family: 'Caveat',
    group: 'decorative',
    label: 'Caveat',
    license: 'OFL-1.1',
    files: { regular: 'Caveat-Regular.ttf', medium: 'Caveat-Medium.ttf', bold: 'Caveat-Bold.ttf' },
  },
  pacifico: {
    family: 'Pacifico',
    group: 'decorative',
    label: 'Pacifico',
    license: 'OFL-1.1',
    // У Pacifico одно начертание — остальные ссылаются на него же.
    files: {
      regular: 'Pacifico-Regular.ttf',
      medium: 'Pacifico-Regular.ttf',
      bold: 'Pacifico-Regular.ttf',
    },
  },
};

/** Шрифт по умолчанию: им заменяется любой неизвестный `fontId` (§5). */
export const DEFAULT_FONT_ID = 'inter';

export const FONT_GROUPS = ['modern', 'strict', 'expressive', 'decorative'];

export function isKnownFont(fontId) {
  return Object.hasOwn(FONT_CATALOG, fontId);
}

/**
 * Семейство и файл для ASS. Неизвестный шрифт — не ошибка: берём шрифт по
 * умолчанию и сообщаем об этом через `note`.
 *
 * @returns {{fontId: string, family: string, file: string, note: string|null}}
 */
export function resolveFont(fontId, weight = 'regular') {
  const id = isKnownFont(fontId) ? fontId : DEFAULT_FONT_ID;
  const note = isKnownFont(fontId)
    ? null
    : `font-fallback: неизвестный шрифт «${fontId}», взят ${DEFAULT_FONT_ID}`;

  const entry = FONT_CATALOG[id];
  const file = entry.files[weight] ?? entry.files.regular;
  return { fontId: id, family: entry.family, file, note };
}

/** Каталог для UI: сгруппированный список без путей к файлам. */
export function catalogForClient() {
  return Object.entries(FONT_CATALOG).map(([fontId, entry]) => ({
    fontId,
    family: entry.family,
    label: entry.label,
    group: entry.group,
    license: entry.license,
    weights: Object.keys(entry.files),
  }));
}
