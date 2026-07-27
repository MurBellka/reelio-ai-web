// Текстовые слои (§4 контракта v2): разбор, безопасная зона, генерация ASS.
//
// Два принципа, ради которых модуль вообще существует отдельно.
//
// 1. Координаты нормализованы. В плане нет пикселей — только доли кадра.
//    Умножение на реальный размер происходит здесь и только здесь, поэтому
//    один и тот же план даёт одинаковую раскладку в 720p, 1080p, 2K и 4K.
//
// 2. Пользовательский текст не касается командной строки. Он попадает только
//    в UTF-8 файл .ass, а FFmpeg получает путь к файлу. Двоеточия, кавычки,
//    запятые и обратные слэши в тексте не могут ничего сломать, потому что
//    парсер filter_complex их никогда не видит.

import {
  ANCHOR_Y,
  HEX_COLOR_RE,
  MAX_FONT_SIZE_RATIO,
  MAX_TEXT_LENGTH,
  MIN_FONT_SIZE_RATIO,
  TEXT_ALIGNS,
  TEXT_ANCHORS,
  TEXT_ANIMATIONS,
  clampToSafeZone,
  isInsideSafeZone,
} from './contract.js';
import { resolveFont } from './fonts.js';

/** Выравнивание → код ASS: 4/5/6 — левый, центральный и правый якорь по середине. */
const ASS_ALIGNMENT = { left: 4, center: 5, right: 6 };

/** Длительности анимаций появления (§4.4), мс. */
const ANIMATION = { fadeMs: 250, slideMs: 300, slideRise: 0.04, popMs: 220, popScale: 60 };

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function color(value, fallback) {
  return typeof value === 'string' && HEX_COLOR_RE.test(value) ? value.toUpperCase() : fallback;
}

/** `#RRGGBB` + прозрачность 0..1 → `&HAABBGGRR` (ASS хранит цвет как ABGR). */
export function assColor(hex, opacity = 1) {
  const m = /^#?([0-9A-Fa-f]{6})$/.exec(String(hex).trim());
  const rgb = m ? m[1].toUpperCase() : 'FFFFFF';
  // В ASS «альфа» — это прозрачность: 00 — непрозрачно, FF — невидимо.
  const alpha = Math.round((1 - clamp(number(opacity, 1), 0, 1)) * 255);
  const aa = alpha.toString(16).padStart(2, '0').toUpperCase();
  return `&H${aa}${rgb.slice(4, 6)}${rgb.slice(2, 4)}${rgb.slice(0, 2)}`;
}

/**
 * Цвет для ИНЛАЙНОВОГО тега `\c` — `&HBBGGRR&`.
 *
 * Форма отличается от цвета в строке стиля: у `\c` нет байта альфы (за неё
 * отвечает отдельный тег `\alpha`), и завершающий `&` обязателен. Восемь
 * разрядов здесь libass разбирает неверно.
 */
export function assColorTag(hex) {
  const m = /^#?([0-9A-Fa-f]{6})$/.exec(String(hex).trim());
  const rgb = m ? m[1].toUpperCase() : 'FFFFFF';
  return `&H${rgb.slice(4, 6)}${rgb.slice(2, 4)}${rgb.slice(0, 2)}&`;
}

/** `0:00:03.25` — таймкод ASS. */
export function assTimecode(seconds) {
  const total = Math.max(0, number(seconds, 0));
  const cs = Math.round((total % 1) * 100);
  const s = Math.floor(total) % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs)}`;
}

/**
 * Экранирование текста для поля Text события ASS.
 *
 * Фигурные скобки открывают блок команд, обратный слэш — управляющая
 * последовательность. Переводы строк превращаются в `\N`. Всё остальное — в
 * том числе `:`, `'`, `,`, `[`, `]` — в ASS безопасно, потому что файл
 * читается как данные, а не как аргумент фильтра.
 */
export function escapeAssText(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r\n?/g, '\n')
    .replace(/\n/g, '\\N');
}

/**
 * Разбивает текст на строки: сначала по явным переводам строки, затем по
 * словам. Порядок важен — если сперва свернуть всё в один абзац, переводы
 * строки, которые поставил пользователь, потеряются безвозвратно.
 */
export function layoutLines(text, maxChars) {
  return String(text)
    .split(/\r\n?|\n/)
    .flatMap((paragraph) => {
      const lines = wrapText(paragraph, maxChars);
      // Пустая строка в тексте — это намеренный отступ, сохраняем её.
      return lines.length > 0 ? lines : [''];
    });
}

/** Перенос по словам: длинные подписи не должны уезжать за кадр. */
export function wrapText(text, maxChars) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= maxChars || !line) line = candidate;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Разбор и нормализация одного слоя.
 *
 * @param {object} raw элемент plan.textOverlays
 * @param {{index: number, segments: object[], totalDuration: number}} ctx
 * @returns {{overlay: object|null, notes: string[], error: string|null}}
 */
export function normalizeOverlay(raw, ctx) {
  const notes = [];
  const field = `plan.textOverlays[${ctx.index}]`;

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { overlay: null, notes, error: `${field}: слой должен быть объектом` };
  }

  const text = String(raw.text ?? '').trim();
  if (!text) return { overlay: null, notes, error: `${field}: пустой текст` };
  if (text.length > MAX_TEXT_LENGTH) {
    return { overlay: null, notes, error: `${field}: текст длиннее ${MAX_TEXT_LENGTH} символов` };
  }

  // ── Время: абсолютное либо относительное клипу ──────────────────────────
  const segment = raw.clipId ? ctx.segments.find((s) => s.id === raw.clipId) : null;
  if (raw.clipId && !segment) {
    return { overlay: null, notes, error: `${field}: слой привязан к неизвестному клипу` };
  }

  const base = segment ? segment.start : 0;
  let start = base + number(raw.startSeconds, 0);
  let end = base + number(raw.endSeconds, number(raw.startSeconds, 0) + 3);

  // Слой, привязанный к клипу, не должен переживать сам клип.
  const upperBound = segment ? Math.min(segment.end, ctx.totalDuration) : ctx.totalDuration;
  start = clamp(start, 0, upperBound);
  end = clamp(end, 0, upperBound);

  if (end - start < 0.1) {
    return { overlay: null, notes, error: `${field}: слой короче 0.1 с` };
  }

  // ── Положение ───────────────────────────────────────────────────────────
  const position = raw.position ?? {};
  const anchor = TEXT_ANCHORS.has(position.anchor) ? position.anchor : 'bottom';
  const x = clamp(number(position.x, 0.5), 0, 1);
  const y = clamp(number(position.y, ANCHOR_Y[anchor]), 0, 1);

  // §4.2: испорченный экспорт хуже сдвинутой на пару процентов подписи.
  const inside = isInsideSafeZone(x, y);
  const safe = inside ? { x, y } : clampToSafeZone(x, y);
  if (!inside) {
    notes.push(
      `text-safe-zone: «${text.slice(0, 24)}» сдвинут внутрь безопасной зоны ` +
        `(${x.toFixed(3)}, ${y.toFixed(3)}) → (${safe.x.toFixed(3)}, ${safe.y.toFixed(3)})`,
    );
  }

  // ── Оформление ──────────────────────────────────────────────────────────
  const font = resolveFont(raw.fontId, raw.fontWeight);
  // Пометка нужна, только если шрифт ЗАПРАШИВАЛИ и он не нашёлся. Отсутствие
  // поля — это не ошибка пользователя, а обычное умолчание.
  if (font.note && raw.fontId !== undefined && raw.fontId !== null) notes.push(font.note);

  const background = raw.background
    ? {
        colorHex: color(raw.background.colorHex, '#000000'),
        opacity: clamp(number(raw.background.opacity, 0.45), 0, 1),
        paddingRatio: clamp(number(raw.background.paddingRatio, 0.02), 0, 0.1),
      }
    : null;

  const outline = raw.outline
    ? {
        colorHex: color(raw.outline.colorHex, '#000000'),
        widthRatio: clamp(number(raw.outline.widthRatio, 0.004), 0, 0.03),
      }
    : null;

  // ASS не умеет одновременно плашку и обводку текста: BorderStyle=3 занимает
  // ту же позицию стиля, что и обводка. Плашка приоритетнее — она читаемее.
  if (background && outline) {
    notes.push('text-style: плашка и обводка вместе не поддерживаются, оставлена плашка');
  }

  const shadow = raw.shadow
    ? {
        colorHex: color(raw.shadow.colorHex, '#000000'),
        opacity: clamp(number(raw.shadow.opacity, 0.6), 0, 1),
        offsetRatio: clamp(number(raw.shadow.offsetRatio, 0.004), 0, 0.03),
      }
    : null;

  return {
    overlay: {
      id: typeof raw.id === 'string' && raw.id ? raw.id : `text_${ctx.index + 1}`,
      text,
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
      clipId: raw.clipId ?? null,
      anchor,
      x: safe.x,
      y: safe.y,
      requestedX: x,
      requestedY: y,
      insideSafeZone: inside,
      fontId: font.fontId,
      fontFamily: font.family,
      fontWeight: raw.fontWeight === 'bold' ? 'bold' : raw.fontWeight === 'medium' ? 'medium' : 'regular',
      fontSizeRatio: clamp(number(raw.fontSizeRatio, 0.055), MIN_FONT_SIZE_RATIO, MAX_FONT_SIZE_RATIO),
      colorHex: color(raw.colorHex, '#FFFFFF'),
      align: TEXT_ALIGNS.has(raw.align) ? raw.align : 'center',
      opacity: clamp(number(raw.opacity, 1), 0, 1),
      background,
      outline: background ? null : outline,
      shadow,
      animation: TEXT_ANIMATIONS.has(raw.animation) ? raw.animation : 'none',
      maxLineChars: Math.round(clamp(number(raw.maxLineChars, 24), 8, 60)),
    },
    notes,
    error: null,
  };
}

/** Строка стиля ASS для одного слоя. Размеры считаются от высоты кадра. */
function styleLine(overlay, { width, height }, styleName) {
  const fontSize = Math.max(8, Math.round(overlay.fontSizeRatio * height));
  const primary = assColor(overlay.colorHex, overlay.opacity);

  // BorderStyle 3 — непрозрачная плашка: OutlineColour заливает её, а Outline
  // задаёт отступ. BorderStyle 1 — обводка текста.
  const hasBox = Boolean(overlay.background);
  const borderStyle = hasBox ? 3 : 1;
  const outlineColour = hasBox
    ? assColor(overlay.background.colorHex, overlay.background.opacity)
    : assColor(overlay.outline?.colorHex ?? '#000000', overlay.outline ? 1 : 0);
  const outlineSize = hasBox
    ? Math.max(1, Math.round(overlay.background.paddingRatio * height))
    : Math.round((overlay.outline?.widthRatio ?? 0) * height);

  const backColour = assColor(overlay.shadow?.colorHex ?? '#000000', overlay.shadow?.opacity ?? 0);
  const shadowSize = Math.round((overlay.shadow?.offsetRatio ?? 0) * height);

  const bold = overlay.fontWeight === 'bold' ? -1 : 0;

  return (
    `Style: ${styleName},${overlay.fontFamily},${fontSize},${primary},${primary},` +
    `${outlineColour},${backColour},${bold},0,0,0,100,100,0,0,${borderStyle},` +
    `${outlineSize},${shadowSize},${ASS_ALIGNMENT[overlay.align]},` +
    `${Math.round(width * 0.04)},${Math.round(width * 0.04)},${Math.round(height * 0.04)},204`
  );
}

/** Инлайновые команды позиционирования и анимации (§4.1, §4.4). */
function inlineTags(overlay, { width, height }) {
  const px = Math.round(overlay.x * width);
  const py = Math.round(overlay.y * height);
  const tags = [];

  if (overlay.animation === 'slide') {
    const from = Math.round(py + ANIMATION.slideRise * height);
    tags.push(`\\move(${px},${from},${px},${py},0,${ANIMATION.slideMs})`);
    tags.push(`\\fad(${ANIMATION.fadeMs},${ANIMATION.fadeMs})`);
  } else {
    tags.push(`\\pos(${px},${py})`);
    if (overlay.animation === 'fade') {
      tags.push(`\\fad(${ANIMATION.fadeMs},${ANIMATION.fadeMs})`);
    }
    if (overlay.animation === 'pop') {
      tags.push(
        `\\fscx${ANIMATION.popScale}\\fscy${ANIMATION.popScale}` +
          `\\t(0,${ANIMATION.popMs},\\fscx100\\fscy100)`,
      );
    }
  }

  // Якорь по середине: положение слоя не зависит от числа строк.
  tags.push(`\\an${ASS_ALIGNMENT[overlay.align]}`);
  return `{${tags.join('')}}`;
}

/**
 * Готовый ASS-файл со всеми слоями.
 *
 * PlayResX/PlayResY равны кадру экспорта, поэтому кегль и отступы, заданные
 * долями, дают одинаковую картинку во всех разрешениях §1.
 *
 * @param {object[]} overlays результат normalizeOverlay
 * @param {{width: number, height: number}} frame
 */
export function overlaysToAss(overlays, frame) {
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    `PlayResX: ${frame.width}`,
    `PlayResY: ${frame.height}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour,' +
      ' Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline,' +
      ' Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  ];

  const styles = [];
  const events = [
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  overlays.forEach((overlay, i) => {
    const styleName = `Overlay${i}`;
    styles.push(styleLine(overlay, frame, styleName));

    const body = layoutLines(overlay.text, overlay.maxLineChars).map(escapeAssText).join('\\N');
    events.push(
      `Dialogue: 0,${assTimecode(overlay.start)},${assTimecode(overlay.end)},${styleName},,0,0,0,,` +
        `${inlineTags(overlay, frame)}${body}`,
    );
  });

  return `${[...header, ...styles, ...events].join('\n')}\n`;
}
