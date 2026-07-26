// Субтитры: генерация SRT и ASS с поддержкой кириллицы.
//
// Почему ASS, а не drawtext: drawtext требует ручного экранирования текста
// (двоеточия, кавычки, проценты) и не умеет karaoke-подсветку. ASS решает и то,
// и другое, а кириллица зависит только от шрифта в образе (DejaVu Sans).
//
// SRT выгружается рядом с MP4 как sidecar: он же используется, если сборка
// FFmpeg собрана без libass и вшить субтитры в кадр невозможно.

/** Максимум символов в строке субтитра — дальше перенос. */
const MAX_LINE_CHARS = 26;
/** Максимум строк в одной реплике. */
const MAX_LINES = 2;

function clampTime(value) {
  return Math.max(0, Number(value) || 0);
}

/** `00:00:03,250` — таймкод SRT. */
export function srtTimecode(seconds) {
  const total = clampTime(seconds);
  const ms = Math.round((total % 1) * 1000);
  const s = Math.floor(total) % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

/** `0:00:03.25` — таймкод ASS (сотые доли, часы без ведущего нуля). */
export function assTimecode(seconds) {
  const total = clampTime(seconds);
  const cs = Math.round((total % 1) * 100);
  const s = Math.floor(total) % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs)}`;
}

/** `#RRGGBB` → `&H00BBGGRR&` — ASS хранит цвет как ABGR. */
export function hexToAssColor(hex, alpha = 0) {
  const m = /^#?([0-9A-Fa-f]{6})$/.exec(String(hex).trim());
  const rgb = m ? m[1].toUpperCase() : 'FFFFFF';
  const rr = rgb.slice(0, 2);
  const gg = rgb.slice(2, 4);
  const bb = rgb.slice(4, 6);
  const aa = String(Math.max(0, Math.min(255, alpha)).toString(16)).padStart(2, '0').toUpperCase();
  return `&H${aa}${bb}${gg}${rr}`;
}

/** Разбивает текст на строки по словам, не разрывая слова. */
export function wrapText(text, maxChars = MAX_LINE_CHARS, maxLines = MAX_LINES) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= maxChars || !line) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);

  if (lines.length <= maxLines) return lines;
  // Лишнее склеиваем в последнюю строку: лучше длинная строка, чем потерянный текст.
  const head = lines.slice(0, maxLines - 1);
  head.push(lines.slice(maxLines - 1).join(' '));
  return head;
}

/** Делит текст на N примерно равных по числу слов частей. */
export function splitIntoChunks(text, parts) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || parts <= 0) return [];

  const count = Math.min(parts, words.length);
  const chunks = [];
  let taken = 0;
  for (let i = 0; i < count; i += 1) {
    const remainingWords = words.length - taken;
    const remainingChunks = count - i;
    const size = Math.ceil(remainingWords / remainingChunks);
    chunks.push(words.slice(taken, taken + size).join(' '));
    taken += size;
  }
  return chunks;
}

/**
 * Реплики субтитров.
 *
 * План (§2) несёт только `captions.sampleText` — распознавания речи в контракте
 * нет. Поэтому текст раскладывается по клипам: одна реплика на клип, в порядке
 * монтажа. Если план всё же принёс готовые `captions.cues` (разрешённое §0
 * дополнение), берутся они.
 *
 * @param {{captions: object, segments: {start: number, end: number}[]}} opts
 */
export function buildCues({ captions, segments }) {
  if (!captions?.enabled) return [];

  if (Array.isArray(captions.cues) && captions.cues.length > 0) {
    return captions.cues
      .map((cue) => ({
        start: clampTime(cue.start),
        end: clampTime(cue.end),
        text: String(cue.text ?? '').trim(),
      }))
      .filter((cue) => cue.text && cue.end > cue.start)
      .sort((a, b) => a.start - b.start);
  }

  const text = String(captions.sampleText ?? '').trim();
  if (!text || segments.length === 0) return [];

  const chunks = splitIntoChunks(text, segments.length);
  return chunks
    .map((chunk, i) => {
      const segment = segments[i];
      // Небольшие отступы от границ клипа, чтобы текст не мигал на переходе.
      const pad = Math.min(0.15, (segment.end - segment.start) * 0.1);
      return { start: segment.start + pad, end: segment.end - pad, text: chunk };
    })
    .filter((cue) => cue.text && cue.end > cue.start);
}

export function toSrt(cues) {
  return `${cues
    .map((cue, i) => {
      const body = wrapText(cue.text).join('\n');
      return `${i + 1}\n${srtTimecode(cue.start)} --> ${srtTimecode(cue.end)}\n${body}\n`;
    })
    .join('\n')}`;
}

/** Экранирует текст для поля Text диалога ASS. */
function escapeAssText(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
}

/** Параметры стиля §2: clean | bold | karaoke. */
function styleParams(style, height, colorHex) {
  const primary = hexToAssColor(colorHex);
  const base = {
    fontSize: Math.round(height / 22),
    bold: 0,
    outline: 2,
    shadow: 1,
    // Полупрозрачная подложка под текстом: 0 — обводка, 3 — «коробка».
    borderStyle: 1,
    primary,
    outlineColor: hexToAssColor('#000000', 40),
    backColor: hexToAssColor('#000000', 128),
    marginV: Math.round(height * 0.12),
  };

  if (style === 'bold') {
    return {
      ...base,
      fontSize: Math.round(height / 15),
      bold: 1,
      outline: Math.max(3, Math.round(height / 400)),
      shadow: 2,
      outlineColor: hexToAssColor('#000000', 0),
    };
  }
  if (style === 'karaoke') {
    return {
      ...base,
      fontSize: Math.round(height / 16),
      bold: 1,
      outline: Math.max(3, Math.round(height / 400)),
      shadow: 0,
      outlineColor: hexToAssColor('#000000', 0),
      // Цвет ещё не «спетых» слов — приглушённый белый.
      secondary: hexToAssColor('#C8C8C8'),
    };
  }
  return base;
}

/** Реплика с karaoke-разметкой `{\kNN}` по словам. */
function karaokeBody(cue) {
  const lines = wrapText(cue.text);
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

  // Перенос строк восстанавливаем по исходной разбивке.
  if (lines.length === 1) return marked.join(' ');
  const firstLineWords = lines[0].split(/\s+/).filter(Boolean).length;
  return `${marked.slice(0, firstLineWords).join(' ')}\\N${marked.slice(firstLineWords).join(' ')}`;
}

/**
 * Готовый ASS-файл. PlayResX/PlayResY равны кадру экспорта, поэтому кегль
 * одинаково смотрится в 720p и 4K.
 *
 * @param {{start: number, end: number, text: string}[]} cues
 * @param {{style: string, colorHex: string, width: number, height: number,
 *          fontName?: string}} opts
 */
export function toAss(cues, opts) {
  const { style = 'clean', colorHex = '#FFFFFF', width, height, fontName = 'DejaVu Sans' } = opts;
  const p = styleParams(style, height, colorHex);
  const secondary = p.secondary ?? hexToAssColor('#FFFFFF');

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour,' +
      ' Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline,' +
      ' Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // Encoding 204 — кириллица; Alignment 2 — по центру снизу.
    `Style: Reelio,${fontName},${p.fontSize},${p.primary},${secondary},${p.outlineColor},${p.backColor},` +
      `${p.bold},0,0,0,100,100,0,0,${p.borderStyle},${p.outline},${p.shadow},2,` +
      `${Math.round(width * 0.08)},${Math.round(width * 0.08)},${p.marginV},204`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const events = cues.map((cue) => {
    const body = style === 'karaoke' ? karaokeBody(cue) : escapeAssText(wrapText(cue.text).join('\\N'));
    return `Dialogue: 0,${assTimecode(cue.start)},${assTimecode(cue.end)},Reelio,,0,0,0,,${body}`;
  });

  return `${[...header, ...events].join('\n')}\n`;
}
