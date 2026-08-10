// Каталог шрифтов (§5 контракта v2).
//
// Главное требование: web-превью и FFmpeg используют ОДИН И ТОТ ЖЕ файл, иначе
// экспорт не совпадёт с тем, что пользователь видел на экране. Поэтому файлы
// лежат в репозитории (assets/fonts/), а не подтягиваются из сети ни клиентом,
// ни образом.
//
// Все шрифты — проверенные open-source семейства Google Fonts с кириллицей;
// файлы лицензий лежат рядом со шрифтами.
//
// ── Почему у каждого начертания своё `family` ───────────────────────────────
// libass выбирает шрифт по ИМЕНИ СЕМЕЙСТВА (Fontname в ASS) плюс флаг Bold,
// а НЕ по числовому весу. У статических файлов Google Fonts:
//   • Regular и Bold делят базовое имя семейства («Montserrat»), и Bold
//     достаётся флагом Bold=1;
//   • Medium несёт ОТДЕЛЬНОЕ типографское имя («Montserrat Medium»), потому
//     что «Montserrat» + Bold=0 всегда даст Regular.
// Если для Medium указать базовое «Montserrat», libass молча нарисует Regular —
// именно эта потеря веса и чинится здесь: `medium` ссылается на точное имя из
// таблицы `name` своего TTF (проверяется тестом соответствия).

/**
 * `fontId` → семейство и начертания.
 *
 * `weights[w].family` обязан совпадать с именем семейства в САМОМ TTF: по нему
 * libass находит нужный файл. `fallbackFrom` помечает начертание, которого у
 * семейства нет отдельным файлом (задокументированный откат, не «тихий»).
 */
export const FONT_CATALOG = {
  inter: {
    family: 'Inter',
    group: 'modern',
    label: 'Inter',
    license: 'OFL-1.1',
    weights: {
      regular: { file: 'Inter-Regular.ttf', family: 'Inter' },
      medium: { file: 'Inter-Medium.ttf', family: 'Inter Medium' },
      bold: { file: 'Inter-Bold.ttf', family: 'Inter' },
    },
  },
  montserrat: {
    family: 'Montserrat',
    group: 'modern',
    label: 'Montserrat',
    license: 'OFL-1.1',
    weights: {
      regular: { file: 'Montserrat-Regular.ttf', family: 'Montserrat' },
      medium: { file: 'Montserrat-Medium.ttf', family: 'Montserrat Medium' },
      bold: { file: 'Montserrat-Bold.ttf', family: 'Montserrat' },
    },
  },
  manrope: {
    family: 'Manrope',
    group: 'modern',
    label: 'Manrope',
    license: 'OFL-1.1',
    weights: {
      regular: { file: 'Manrope-Regular.ttf', family: 'Manrope' },
      medium: { file: 'Manrope-Medium.ttf', family: 'Manrope Medium' },
      bold: { file: 'Manrope-Bold.ttf', family: 'Manrope' },
    },
  },
  roboto: {
    family: 'Roboto',
    group: 'strict',
    label: 'Roboto',
    license: 'OFL-1.1',
    weights: {
      regular: { file: 'Roboto-Regular.ttf', family: 'Roboto' },
      medium: { file: 'Roboto-Medium.ttf', family: 'Roboto Medium' },
      bold: { file: 'Roboto-Bold.ttf', family: 'Roboto' },
    },
  },
  pt_sans: {
    family: 'PT Sans',
    group: 'strict',
    label: 'PT Sans',
    license: 'OFL-1.1',
    // У PT Sans в наборе только Regular и Bold. Medium — задокументированный
    // откат на Regular (НЕ на Bold: это изменило бы вес в другую сторону).
    weights: {
      regular: { file: 'PTSans-Regular.ttf', family: 'PT Sans' },
      medium: { file: 'PTSans-Regular.ttf', family: 'PT Sans', fallbackFrom: 'medium' },
      bold: { file: 'PTSans-Bold.ttf', family: 'PT Sans' },
    },
  },
  oswald: {
    family: 'Oswald',
    group: 'expressive',
    label: 'Oswald',
    license: 'OFL-1.1',
    weights: {
      regular: { file: 'Oswald-Regular.ttf', family: 'Oswald' },
      medium: { file: 'Oswald-Medium.ttf', family: 'Oswald Medium' },
      bold: { file: 'Oswald-Bold.ttf', family: 'Oswald' },
    },
  },
  unbounded: {
    family: 'Unbounded',
    group: 'expressive',
    label: 'Unbounded',
    license: 'OFL-1.1',
    weights: {
      regular: { file: 'Unbounded-Regular.ttf', family: 'Unbounded' },
      medium: { file: 'Unbounded-Medium.ttf', family: 'Unbounded Medium' },
      bold: { file: 'Unbounded-Bold.ttf', family: 'Unbounded' },
    },
  },
  caveat: {
    family: 'Caveat',
    group: 'decorative',
    label: 'Caveat',
    license: 'OFL-1.1',
    weights: {
      regular: { file: 'Caveat-Regular.ttf', family: 'Caveat' },
      medium: { file: 'Caveat-Medium.ttf', family: 'Caveat Medium' },
      bold: { file: 'Caveat-Bold.ttf', family: 'Caveat' },
    },
  },
  pacifico: {
    family: 'Pacifico',
    group: 'decorative',
    label: 'Pacifico',
    license: 'OFL-1.1',
    // У Pacifico честно одно начертание. Medium — откат на Regular; Bold
    // libass рисует синтетически по флагу Bold. И то и другое задокументировано.
    weights: {
      regular: { file: 'Pacifico-Regular.ttf', family: 'Pacifico' },
      medium: { file: 'Pacifico-Regular.ttf', family: 'Pacifico', fallbackFrom: 'medium' },
      bold: { file: 'Pacifico-Regular.ttf', family: 'Pacifico', fallbackFrom: 'bold' },
    },
  },
};

/** Логические начертания, поддерживаемые каждым семейством (§5/§4). */
export const FONT_WEIGHTS = ['regular', 'medium', 'bold'];

/** Шрифт по умолчанию: им заменяется любой неизвестный `fontId` (§5). */
export const DEFAULT_FONT_ID = 'inter';

export const FONT_GROUPS = ['modern', 'strict', 'expressive', 'decorative'];

export function isKnownFont(fontId) {
  return Object.hasOwn(FONT_CATALOG, fontId);
}

/**
 * Семейство и файл для ASS. Неизвестный шрифт — не ошибка: берём шрифт по
 * умолчанию и сообщаем об этом через `note`. То же для начертания, которого у
 * семейства нет отдельным файлом.
 *
 * `family` — точное имя из таблицы `name` выбранного TTF, чтобы libass взял
 * ИМЕННО этот файл (в частности, реальный Medium, а не Regular).
 *
 * @returns {{fontId: string, family: string, file: string, weight: string,
 *   requestedWeight: string, note: string|null}}
 */
export function resolveFont(fontId, weight = 'regular') {
  const known = isKnownFont(fontId);
  const id = known ? fontId : DEFAULT_FONT_ID;
  const entry = FONT_CATALOG[id];

  const notes = [];
  if (!known) {
    notes.push(`font-fallback: неизвестный шрифт «${fontId}», взят ${DEFAULT_FONT_ID}`);
  }

  const hasWeight = Object.hasOwn(entry.weights, weight);
  const w = hasWeight ? weight : 'regular';
  const wentry = entry.weights[w];

  if (!hasWeight) {
    notes.push(`font-weight-fallback: неизвестное начертание «${weight}», взят regular`);
  } else if (wentry.fallbackFrom) {
    notes.push(
      `font-weight-fallback: у «${entry.family}» нет отдельного ${wentry.fallbackFrom}, взят regular`,
    );
  }

  return {
    fontId: id,
    family: wentry.family,
    file: wentry.file,
    weight: w,
    requestedWeight: weight,
    note: notes.length > 0 ? notes.join('; ') : null,
  };
}

/** Каталог для UI: сгруппированный список без путей к файлам. */
export function catalogForClient() {
  return Object.entries(FONT_CATALOG).map(([fontId, entry]) => ({
    fontId,
    family: entry.family,
    label: entry.label,
    group: entry.group,
    license: entry.license,
    weights: Object.keys(entry.weights),
  }));
}
