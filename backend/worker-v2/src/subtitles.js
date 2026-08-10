// Субтитры (§6 контракта v2): генерация SRT и ASS с поддержкой кириллицы.
//
// Почему ASS, а не drawtext: drawtext требует ручного экранирования текста
// (двоеточия, кавычки, проценты) и не умеет karaoke-подсветку. ASS решает и то,
// и другое, а кириллица зависит только от шрифта каталога (§5).
//
// Реплики приходят готовыми из распознавания речи — worker сам речь не
// распознаёт (§6.1). Если распознанных реплик нет, используется `sampleText`
// из v1, разложенный по клипам.
//
// SRT выгружается рядом с MP4 sidecar-файлом: он же остаётся единственным
// носителем субтитров, если сборка FFmpeg собрана без libass.

import { ANCHOR_Y, SAFE_ZONE } from './contract.js';
import { resolveFont } from './fonts.js';
import { assColor, assColorTag, assTimecode, escapeAssText, wrapText } from './textoverlay.js';

export { assTimecode, wrapText };

/** Максимум строк в одной реплике. */
const MAX_LINES = 2;

/** `00:00:03,250` — таймкод SRT. */
export function srtTimecode(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const ms = Math.round((total % 1) * 1000);
  const s = Math.floor(total) % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

/** Делит текст на N примерно равных по числу слов частей. */
export function splitIntoChunks(text, parts) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || parts <= 0) return [];

  const count = Math.min(parts, words.length);
  const chunks = [];
  let taken = 0;
  for (let i = 0; i < count; i += 1) {
    const size = Math.ceil((words.length - taken) / (count - i));
    chunks.push(words.slice(taken, taken + size).join(' '));
    taken += size;
  }
  return chunks;
}

/**
 * Реплики субтитров.
 *
 * Приоритет — распознанная речь (`captions.cues`). Форма v1 (`sampleText`)
 * остаётся запасным вариантом и раскладывается по клипам: одна реплика на клип.
 *
 * @param {{captions: object, segments: {start: number, end: number}[]}} opts
 */
export function buildCues({ captions, segments }) {
  if (!captions?.enabled) return [];

  if (Array.isArray(captions.cues) && captions.cues.length > 0) {
    return captions.cues
      .map((cue) => ({
        start: Math.max(0, Number(cue.start) || 0),
        end: Math.max(0, Number(cue.end) || 0),
        text: String(cue.text ?? '').trim(),
        words: Array.isArray(cue.words) ? cue.words : [],
      }))
      .filter((cue) => cue.text && cue.end > cue.start)
      .sort((a, b) => a.start - b.start);
  }

  const text = String(captions.sampleText ?? '').trim();
  if (!text || segments.length === 0) return [];

  return splitIntoChunks(text, segments.length)
    .map((chunk, i) => {
      const segment = segments[i];
      // Небольшие отступы от границ клипа, чтобы текст не мигал на переходе.
      const pad = Math.min(0.15, (segment.end - segment.start) * 0.1);
      return { start: segment.start + pad, end: segment.end - pad, text: chunk, words: [] };
    })
    .filter((cue) => cue.text && cue.end > cue.start);
}

export function toSrt(cues, maxLineChars = 26) {
  return cues
    .map((cue, i) => {
      const body = wrapText(cue.text, maxLineChars).slice(0, MAX_LINES).join('\n');
      return `${i + 1}\n${srtTimecode(cue.start)} --> ${srtTimecode(cue.end)}\n${body}\n`;
    })
    .join('\n');
}

/** §6 — параметры четырёх стилей субтитров. */
function styleParams(style, height, colorHex) {
  const primary = assColor(colorHex);
  const base = {
    fontSizeRatio: 0.045,
    bold: 0,
    borderStyle: 1,
    outlineRatio: 0.003,
    shadowRatio: 0.002,
    outlineColor: assColor('#000000', 0.85),
    backColor: assColor('#000000', 0.5),
    primary,
  };

  if (style === 'bold') {
    return {
      ...base,
      fontSizeRatio: 0.062,
      bold: -1,
      outlineRatio: 0.005,
      shadowRatio: 0.003,
      outlineColor: assColor('#000000', 1),
    };
  }
  if (style === 'karaoke') {
    return {
      ...base,
      fontSizeRatio: 0.058,
      bold: -1,
      outlineRatio: 0.005,
      shadowRatio: 0,
      outlineColor: assColor('#000000', 1),
    };
  }
  if (style === 'minimal') {
    // Без обводки и тени: тонкая подпись, которая не спорит с картинкой.
    return {
      ...base,
      fontSizeRatio: 0.036,
      outlineRatio: 0,
      shadowRatio: 0,
      outlineColor: assColor('#000000', 0),
    };
  }
  return base;
}

/** Вертикальный отступ от края кадра для выбранной позиции (§4.2). */
function marginVFor(position, height) {
  if (position === 'top') return Math.round(ANCHOR_Y.top * height);
  if (position === 'center') return Math.round(height * 0.5 - 0.5 * height * 0.06);
  // Снизу отступ равен безопасной зоне: под ней кнопки Reels.
  return Math.round(SAFE_ZONE.bottom * height);
}

/** Код выравнивания ASS: 8 — сверху по центру, 5 — по центру, 2 — снизу. */
const ALIGNMENT_BY_POSITION = { top: 8, center: 5, bottom: 2 };

/** Реплика с karaoke-разметкой `{\kNN}` по словам. */
function karaokeBody(cue, maxLineChars) {
  const lines = wrapText(cue.text, maxLineChars).slice(0, MAX_LINES);
  const words = lines.join(' ').split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';

  const totalCs = Math.max(1, Math.round((cue.end - cue.start) * 100));
  let used = 0;

  const marked = words.map((word, i) => {
    const remaining = words.length - i;
    const cs = i === words.length - 1 ? totalCs - used : Math.max(1, Math.round((totalCs - used) / remaining));
    used += cs;
    return `{\\k${cs}}${escapeAssText(word)}`;
  });

  if (lines.length <= 1) return marked.join(' ');
  const firstLineWords = lines[0].split(/\s+/).filter(Boolean).length;
  return `${marked.slice(0, firstLineWords).join(' ')}\\N${marked.slice(firstLineWords).join(' ')}`;
}

/** Реплика с выделением отдельных слов цветом (§6). */
function highlightedBody(cue, maxLineChars, highlightColor, primaryColor) {
  const flagged = new Map(
    (cue.words ?? []).filter((w) => w.highlight).map((w) => [String(w.text).toLowerCase(), true]),
  );
  if (flagged.size === 0) {
    return wrapText(cue.text, maxLineChars).slice(0, MAX_LINES).map(escapeAssText).join('\\N');
  }

  return wrapText(cue.text, maxLineChars)
    .slice(0, MAX_LINES)
    .map((line) =>
      line
        .split(/\s+/)
        .map((word) => {
          // Пунктуация не должна мешать сопоставлению со словом из распознавания.
          const bare = word.replace(/[.,!?:;«»()"']/g, '').toLowerCase();
          const escaped = escapeAssText(word);
          return flagged.has(bare) ? `{\\c${highlightColor}}${escaped}{\\c${primaryColor}}` : escaped;
        })
        .join(' '),
    )
    .join('\\N');
}

/**
 * Готовый ASS-файл субтитров.
 *
 * PlayResX/PlayResY равны кадру экспорта, поэтому кегль, заданный долей высоты,
 * одинаково смотрится в 720p, 1080p, 2K и 4K.
 *
 * @param {{start: number, end: number, text: string, words?: object[]}[]} cues
 * @param {{style: string, colorHex: string, highlightColorHex?: string,
 *          fontId?: string, position?: string, maxLineChars?: number,
 *          width: number, height: number}} opts
 */
export function toAss(cues, opts) {
  const {
    style = 'clean',
    colorHex = '#FFFFFF',
    highlightColorHex = '#A855F7',
    fontId,
    position = 'bottom',
    maxLineChars = 26,
    width,
    height,
  } = opts;

  const font = resolveFont(fontId, style === 'clean' || style === 'minimal' ? 'medium' : 'bold');
  const p = styleParams(style, height, colorHex);
  const primary = assColor(colorHex);
  const highlight = assColor(highlightColorHex);
  // Для инлайновых тегов нужна другая форма записи цвета, чем в строке стиля.
  const primaryTag = assColorTag(colorHex);
  const highlightTag = assColorTag(highlightColorHex);

  // В karaoke SecondaryColour — цвет ещё не «спетых» слов.
  const secondary = style === 'karaoke' ? highlight : primary;

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour,' +
      ' Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline,' +
      ' Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // Encoding 204 — кириллица.
    `Style: Reelio,${font.family},${Math.round(p.fontSizeRatio * height)},${primary},${secondary},` +
      `${p.outlineColor},${p.backColor},${p.bold},0,0,0,100,100,0,0,${p.borderStyle},` +
      `${Math.round(p.outlineRatio * height)},${Math.round(p.shadowRatio * height)},` +
      `${ALIGNMENT_BY_POSITION[position] ?? 2},` +
      `${Math.round(width * SAFE_ZONE.left)},${Math.round(width * SAFE_ZONE.right)},` +
      `${marginVFor(position, height)},204`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const events = cues.map((cue) => {
    const body =
      style === 'karaoke'
        ? karaokeBody(cue, maxLineChars)
        : highlightedBody(cue, maxLineChars, highlightTag, primaryTag);
    return `Dialogue: 0,${assTimecode(cue.start)},${assTimecode(cue.end)},Reelio,,0,0,0,,${body}`;
  });

  return `${[...header, ...events].join('\n')}\n`;
}
