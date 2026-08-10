// Минимальный читатель TrueType: покрытие символов и имя семейства.
//
// Нужен ровно для одной проверки, которую нельзя сделать «на глаз»: каждый
// шрифт каталога (§5) обязан содержать кириллицу. Скачанный файл может
// оказаться латинским сабсетом, и обнаружится это только на экспорте, когда
// вместо русского текста выйдут пустые прямоугольники.

/** Таблицы sfnt: тег → {offset, length}. */
export function readTableDirectory(buffer) {
  const tag = buffer.readUInt32BE(0);
  if (tag !== 0x00010000 && tag !== 0x74727565 && tag !== 0x4f54544f) {
    throw new Error(`не sfnt: тег 0x${tag.toString(16)}`);
  }
  const count = buffer.readUInt16BE(4);
  const tables = new Map();
  for (let i = 0; i < count; i += 1) {
    const base = 12 + 16 * i;
    tables.set(buffer.toString('latin1', base, base + 4), {
      offset: buffer.readUInt32BE(base + 8),
      length: buffer.readUInt32BE(base + 12),
    });
  }
  return tables;
}

/** cmap формата 4 (BMP): сегменты с дельтами. */
function lookupFormat4(buffer, offset, codePoint) {
  if (codePoint > 0xffff) return 0;
  const segCountX2 = buffer.readUInt16BE(offset + 6);
  const segCount = segCountX2 / 2;

  const endBase = offset + 14;
  const startBase = endBase + segCountX2 + 2;
  const deltaBase = startBase + segCountX2;
  const rangeBase = deltaBase + segCountX2;

  for (let i = 0; i < segCount; i += 1) {
    const end = buffer.readUInt16BE(endBase + i * 2);
    if (codePoint > end) continue;
    const start = buffer.readUInt16BE(startBase + i * 2);
    if (codePoint < start) return 0;

    const idDelta = buffer.readInt16BE(deltaBase + i * 2);
    const idRangeOffset = buffer.readUInt16BE(rangeBase + i * 2);
    if (idRangeOffset === 0) return (codePoint + idDelta) & 0xffff;

    const glyphOffset = rangeBase + i * 2 + idRangeOffset + (codePoint - start) * 2;
    if (glyphOffset + 1 >= buffer.length) return 0;
    const glyph = buffer.readUInt16BE(glyphOffset);
    return glyph === 0 ? 0 : (glyph + idDelta) & 0xffff;
  }
  return 0;
}

/** cmap формата 12 (полный Unicode): группы диапазонов. */
function lookupFormat12(buffer, offset, codePoint) {
  const groups = buffer.readUInt32BE(offset + 12);
  for (let i = 0; i < groups; i += 1) {
    const base = offset + 16 + i * 12;
    const start = buffer.readUInt32BE(base);
    const end = buffer.readUInt32BE(base + 4);
    if (codePoint < start) return 0;
    if (codePoint > end) continue;
    return buffer.readUInt32BE(base + 8) + (codePoint - start);
  }
  return 0;
}

/**
 * Индекс глифа для кодовой точки, 0 — символа в шрифте нет.
 * Предпочитаем полный Unicode (формат 12), иначе BMP (формат 4).
 */
export function glyphForCodePoint(buffer, codePoint) {
  const cmap = readTableDirectory(buffer).get('cmap');
  if (!cmap) throw new Error('нет таблицы cmap');

  const count = buffer.readUInt16BE(cmap.offset + 2);
  const subtables = [];
  for (let i = 0; i < count; i += 1) {
    const rec = cmap.offset + 4 + i * 8;
    subtables.push({
      platformId: buffer.readUInt16BE(rec),
      encodingId: buffer.readUInt16BE(rec + 2),
      offset: cmap.offset + buffer.readUInt32BE(rec + 4),
    });
  }

  const scored = subtables
    .map((s) => ({ ...s, format: buffer.readUInt16BE(s.offset) }))
    .filter((s) => s.format === 4 || s.format === 12)
    .sort((a, b) => b.format - a.format);

  for (const subtable of scored) {
    const glyph =
      subtable.format === 12
        ? lookupFormat12(buffer, subtable.offset, codePoint)
        : lookupFormat4(buffer, subtable.offset, codePoint);
    if (glyph !== 0) return glyph;
  }
  return 0;
}

/** Есть ли в шрифте все символы строки (пробелы игнорируются). */
export function coversText(buffer, text) {
  const missing = [];
  for (const char of text) {
    if (char === ' ') continue;
    if (glyphForCodePoint(buffer, char.codePointAt(0)) === 0) missing.push(char);
  }
  return { ok: missing.length === 0, missing };
}

/** Декодирует одну запись таблицы `name` в строку. */
function decodeNameRecord(buffer, platformId, offset, length) {
  const raw = buffer.subarray(offset, offset + length);
  // Платформа 3 (Windows) хранит строки в UTF-16BE, платформа 1 — в ASCII.
  // Node умеет только UTF-16LE, поэтому пары байт читаем сами.
  if (platformId !== 3) return raw.toString('latin1');
  let text = '';
  for (let i = 0; i + 1 < raw.length; i += 2) text += String.fromCharCode(raw.readUInt16BE(i));
  return text;
}

/**
 * Все строки таблицы `name` для указанных nameID → Set.
 * По умолчанию — семейственные имена: 1 (Family), 4 (Full name),
 * 16 (Typographic Family). Именно среди них libass ищет Fontname.
 */
export function nameStrings(buffer, nameIds = [1, 4, 16]) {
  const wanted = new Set(nameIds);
  const result = new Set();
  const name = readTableDirectory(buffer).get('name');
  if (!name) return result;

  const count = buffer.readUInt16BE(name.offset + 2);
  const stringOffset = name.offset + buffer.readUInt16BE(name.offset + 4);

  for (let i = 0; i < count; i += 1) {
    const rec = name.offset + 6 + i * 12;
    const platformId = buffer.readUInt16BE(rec);
    const nameId = buffer.readUInt16BE(rec + 6);
    if (!wanted.has(nameId)) continue;

    const length = buffer.readUInt16BE(rec + 8);
    const offset = stringOffset + buffer.readUInt16BE(rec + 10);
    const text = decodeNameRecord(buffer, platformId, offset, length);
    if (text) result.add(text);
  }
  return result;
}

/** Имя семейства из таблицы `name` (nameID 1) — сверка с каталогом. */
export function familyName(buffer) {
  const name = readTableDirectory(buffer).get('name');
  if (!name) return null;

  const count = buffer.readUInt16BE(name.offset + 2);
  const stringOffset = name.offset + buffer.readUInt16BE(name.offset + 4);

  for (let i = 0; i < count; i += 1) {
    const rec = name.offset + 6 + i * 12;
    const platformId = buffer.readUInt16BE(rec);
    const nameId = buffer.readUInt16BE(rec + 6);
    if (nameId !== 1) continue;

    const length = buffer.readUInt16BE(rec + 8);
    const offset = stringOffset + buffer.readUInt16BE(rec + 10);
    return decodeNameRecord(buffer, platformId, offset, length);
  }
  return null;
}
