// Обезвреживание ответа Gemini (§15 задания).
//
// Главный принцип: **ответ модели — это выбор из закрытых множеств, а не
// текст, который куда-то подставляется**. Модель не может назвать файл,
// собрать путь, задать фильтр FFmpeg или передать флаг. Она может только
// выбрать один из вариантов, которые сервер уже знает, и назвать число,
// которое сервер зажмёт в свой диапазон.
//
// Практически это значит:
//   • идентификаторы материалов и клипов сверяются со списком, который
//     составил СЕРВЕР по загруженным файлам; всё остальное отбрасывается;
//   • переходы, шрифты, стили, анимации — только из перечислений контракта;
//   • числа — только после clamp в допустимый диапазон;
//   • свободный текст допускается ровно в одном месте (подписи и субтитры) и
//     никогда не попадает в командную строку: worker пишет его в .ass файл;
//   • путей, имён файлов и любых строк, похожих на аргументы FFmpeg, в ответе
//     не бывает в принципе — таких полей в схеме просто нет.

/**
 * Управляющие и невидимые символы, которые не должны попасть даже в .ass:
 * C0/C1-контролы, zero-width пробелы и bidi-переключатели. Последние особенно
 * неприятны — ими можно визуально развернуть текст, не меняя содержимого.
 * Обычные пробельные символы не трогаем: их схлопывает `\s+` ниже.
 */
const CONTROL_CHARS = new RegExp(
  '[' +
    '\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F' + // C0 без \t \n \r
    '\\u007F-\\u009F' +                                   // DEL и C1
    '\\u200B-\\u200F' +                                   // zero-width и bidi-метки
    '\\u2028-\\u202E' +                                   // разделители строк и bidi-override
    '\\u2060-\\u2064\\uFEFF' +                           // word-joiner и BOM
    ']',
  'g',
);

/** Признаки попытки выдать за текст путь, команду или фильтр. */
const INJECTION_MARKERS = [
  /\bgs:\/\//i,
  /\bfile:\/\//i,
  /\.\.[/\\]/,
  /\$\(/,
  /`/,
  /\bffmpeg\b/i,
  /\bfilter_complex\b/i,
  /\bdrawtext\b/i,
  /\bsubtitles\s*=/i,
  /\bmovie\s*=/i,
  /\bconcat\s*:/i,
];

export class UnsafeModelOutputError extends Error {
  constructor(field, reason) {
    super(`Ответ модели отклонён: ${reason}`);
    this.name = 'UnsafeModelOutputError';
    this.code = 'MODEL_OUTPUT_REJECTED';
    this.field = field;
    this.reason = reason;
    this.retryable = true;
  }
}

/**
 * Число в диапазоне; всё нечисловое превращается в fallback.
 *
 * Осторожно с приведением типов: `Number(null)`, `Number('')`, `Number(false)`
 * и `Number([])` дают 0 — то есть отсутствующее значение молча стало бы
 * валидным нулём. Для координат и длительностей это тихая порча данных,
 * поэтому принимаем только число или непустую числовую строку.
 */
export function clampNumber(value, min, max, fallback) {
  if (typeof value !== 'number' && typeof value !== 'string') return fallback;
  if (typeof value === 'string' && value.trim() === '') return fallback;

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Значение из закрытого множества либо fallback. Никаких «похожих». */
export function pickEnum(value, allowed, fallback) {
  const set = allowed instanceof Set ? allowed : new Set(allowed);
  return set.has(value) ? value : fallback;
}

/**
 * Идентификатор, который ОБЯЗАН существовать в серверном списке.
 * Возвращает null, если модель придумала несуществующий id.
 */
export function pickKnownId(value, knownIds) {
  if (typeof value !== 'string') return null;
  const set = knownIds instanceof Set ? knownIds : new Set(knownIds);
  return set.has(value) ? value : null;
}

/** Цвет только в виде #RRGGBB; всё остальное — fallback. */
export function safeColor(value, fallback = '#FFFFFF') {
  return typeof value === 'string' && /^#[0-9A-Fa-f]{6}$/.test(value.trim())
    ? value.trim().toUpperCase()
    : fallback;
}

/**
 * Свободный текст подписи. Единственное место, где модель влияет на строку,
 * которую увидит пользователь.
 *
 * Что делаем: снимаем управляющие символы, схлопываем пробелы, режем по длине.
 * Чего НЕ делаем: не экранируем под FFmpeg — потому что этот текст никогда не
 * окажется в командной строке. Экранированием под ASS занимается worker, и это
 * правильное место: там известен формат файла.
 *
 * @throws {UnsafeModelOutputError} если текст выглядит как путь или команда
 */
export function safeText(value, { field = 'text', maxLength = 200, allowEmpty = false } = {}) {
  if (typeof value !== 'string') {
    if (allowEmpty) return '';
    throw new UnsafeModelOutputError(field, 'текст отсутствует или не строка');
  }

  const cleaned = value
    .replace(CONTROL_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);

  if (!cleaned) {
    if (allowEmpty) return '';
    throw new UnsafeModelOutputError(field, 'пустой текст');
  }

  for (const marker of INJECTION_MARKERS) {
    if (marker.test(cleaned)) {
      throw new UnsafeModelOutputError(field, 'текст похож на путь или команду');
    }
  }

  return cleaned;
}

/**
 * Последний рубеж: рекурсивно убеждается, что в готовой структуре нет строк,
 * похожих на путь, команду или аргумент FFmpeg.
 *
 * Вызывается уже ПОСЛЕ построения EditPlan — как страховка от того, что новое
 * поле добавили в схему и забыли обезвредить.
 *
 * @param {unknown} value проверяемая структура
 * @param {{textFields?: Set<string>}} opts поля со свободным текстом, где
 *   пунктуация ожидаема и проверяется мягче
 */
export function assertNoCommandLikeStrings(value, opts = {}, pathPrefix = '') {
  const textFields = opts.textFields ?? new Set(['text', 'sampleText', 'prompt', 'reason', 'summary']);

  if (typeof value === 'string') {
    const leaf = pathPrefix.split('.').pop()?.replace(/\[\d+\]$/, '') ?? '';
    const isFreeText = textFields.has(leaf);

    // Путь или команда недопустимы ВЕЗДЕ, включая подписи: в тексте ролика
    // «gs://…» — это не пунктуация, а признак того, что модель подставила
    // внутреннее значение.
    for (const marker of INJECTION_MARKERS) {
      if (marker.test(value)) {
        throw new UnsafeModelOutputError(pathPrefix, 'значение похоже на путь или команду');
      }
    }

    // А вот разделители фильтров в свободном тексте законны: «то ли одно;
    // то ли другое» — обычная фраза, и в командную строку она не попадёт.
    if (!isFreeText && /[;|]/.test(value)) {
      throw new UnsafeModelOutputError(pathPrefix, 'значение содержит разделители фильтра');
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoCommandLikeStrings(item, opts, `${pathPrefix}[${i}]`));
    return;
  }

  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      assertNoCommandLikeStrings(item, opts, pathPrefix ? `${pathPrefix}.${key}` : key);
    }
  }
}

/**
 * Разбор JSON из ответа модели.
 *
 * Gemini со structured output обязан вернуть чистый JSON, но на практике
 * прилетает и ```json-обёртка, и текст вокруг. Пытаемся разобрать строго,
 * затем — вырезав обёртку. Ничего «чинить» регулярками сверх этого не будем:
 * непонятный ответ безопаснее отвергнуть и повторить запрос.
 */
export function parseModelJson(raw, field = 'response') {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new UnsafeModelOutputError(field, 'пустой ответ модели');
  }

  const attempts = [raw.trim()];

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fenced) attempts.push(fenced[1].trim());

  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    attempts.push(raw.slice(firstBrace, lastBrace + 1));
  }

  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // Следующая попытка.
    }
  }

  throw new UnsafeModelOutputError(field, 'ответ не является корректным JSON-объектом');
}
