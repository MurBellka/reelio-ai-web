#!/usr/bin/env node
// Загружает каталог шрифтов (§5 контракта v2) в assets/fonts/.
//
// Запускается вручную при изменении каталога, а не при каждой сборке: файлы
// коммитятся в репозиторий, потому что web-превью и FFmpeg обязаны
// использовать ОДИН И ТОТ ЖЕ файл — иначе экспорт не совпадёт с экраном.
//
//   node tools/fetch-fonts.mjs
//
// Откуда берутся файлы. В google/fonts статические начертания давно заменены
// вариативными, а libass не умеет выставлять ось веса — «жирный» получался бы
// синтетическим и не совпадал бы с превью. Поэтому статические инстансы
// берутся у самого Google Fonts CSS API: со старым мобильным User-Agent он
// отдаёт по одному честному TTF на каждый запрошенный вес.
//
// Лицензии (OFL / Apache) кладутся рядом со шрифтами.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'assets/fonts');

/** UA, при котором CSS API отдаёт статические TTF, а не woff2/EOT. */
const TTF_USER_AGENT =
  'Mozilla/5.0 (Linux; U; Android 4.0.3; ru-ru; Nexus S Build/IML74K) ' +
  'AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30';

/** Вес CSS → имя начертания в каталоге. */
const WEIGHTS = { 400: 'Regular', 500: 'Medium', 700: 'Bold' };

/**
 * Семейства каталога. `licenseUrl` — файл лицензии из google/fonts.
 * У Pacifico единственное начертание, поэтому запрашивается только 400.
 */
const FAMILIES = [
  { family: 'Inter', file: 'Inter', weights: [400, 500, 700], licenseUrl: 'ofl/inter/OFL.txt' },
  { family: 'Montserrat', file: 'Montserrat', weights: [400, 500, 700], licenseUrl: 'ofl/montserrat/OFL.txt' },
  { family: 'Manrope', file: 'Manrope', weights: [400, 500, 700], licenseUrl: 'ofl/manrope/OFL.txt' },
  // Roboto перелицензирован с Apache 2.0 на OFL 1.1 и переехал в ofl/.
  { family: 'Roboto', file: 'Roboto', weights: [400, 500, 700], licenseUrl: 'ofl/roboto/OFL.txt' },
  { family: 'PT Sans', file: 'PTSans', weights: [400, 700], licenseUrl: 'ofl/ptsans/OFL.txt' },
  { family: 'Oswald', file: 'Oswald', weights: [400, 500, 700], licenseUrl: 'ofl/oswald/OFL.txt' },
  { family: 'Unbounded', file: 'Unbounded', weights: [400, 500, 700], licenseUrl: 'ofl/unbounded/OFL.txt' },
  { family: 'Caveat', file: 'Caveat', weights: [400, 500, 700], licenseUrl: 'ofl/caveat/OFL.txt' },
  { family: 'Pacifico', file: 'Pacifico', weights: [400], licenseUrl: 'ofl/pacifico/OFL.txt' },
];

const GOOGLE_FONTS_RAW = 'https://raw.githubusercontent.com/google/fonts/main';

async function fetchText(url, headers = {}) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`GET ${url} → ${response.status}`);
  return response.text();
}

async function fetchBinary(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} → ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Разбирает CSS в пары «вес → URL файла». */
function parseFontFaces(css) {
  const byWeight = new Map();
  for (const block of css.split('@font-face').slice(1)) {
    const weight = /font-weight:\s*(\d+)/.exec(block)?.[1];
    const url = /url\((https:\/\/[^)]+)\)/.exec(block)?.[1];
    if (weight && url) byWeight.set(Number(weight), url);
  }
  return byWeight;
}

/** Грубая проверка: это sfnt с таблицей cmap, а не EOT и не woff. */
function assertTrueType(buffer, name) {
  const tag = buffer.readUInt32BE(0);
  // 0x00010000 — TrueType, 'true' — старый Apple, 'OTTO' — CFF.
  if (tag !== 0x00010000 && tag !== 0x74727565 && tag !== 0x4f54544f) {
    throw new Error(`${name}: не TrueType (тег 0x${tag.toString(16)})`);
  }
  const tableCount = buffer.readUInt16BE(4);
  const tables = [];
  for (let i = 0; i < tableCount; i += 1) {
    tables.push(buffer.toString('latin1', 12 + 16 * i, 12 + 16 * i + 4));
  }
  if (!tables.includes('cmap')) throw new Error(`${name}: нет таблицы cmap`);
  if (tables.includes('fvar')) throw new Error(`${name}: вариативный шрифт, нужен статический`);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  let downloaded = 0;

  for (const spec of FAMILIES) {
    const query = `${spec.family.replace(/ /g, '+')}:wght@${spec.weights.join(';')}`;
    const css = await fetchText(`https://fonts.googleapis.com/css2?family=${query}`, {
      'User-Agent': TTF_USER_AGENT,
    });
    const byWeight = parseFontFaces(css);

    for (const weight of spec.weights) {
      const url = byWeight.get(weight);
      if (!url) throw new Error(`${spec.family}: CSS API не отдал вес ${weight}`);

      const name = `${spec.file}-${WEIGHTS[weight]}.ttf`;
      const buffer = await fetchBinary(url);
      assertTrueType(buffer, name);
      await writeFile(path.join(OUT_DIR, name), buffer);

      console.log(`${name.padEnd(28)} ${(buffer.length / 1024).toFixed(0)} КБ`);
      downloaded += 1;
    }

    const license = await fetchText(`${GOOGLE_FONTS_RAW}/${spec.licenseUrl}`);
    const licenseName = `${spec.file}-LICENSE.txt`;
    await writeFile(path.join(OUT_DIR, licenseName), license);
    console.log(`${licenseName.padEnd(28)} ${(license.length / 1024).toFixed(0)} КБ`);
  }

  console.log(`\nГотово: ${downloaded} начертаний, ${FAMILIES.length} лицензий → assets/fonts/`);
}

main().catch((err) => {
  console.error(`Ошибка: ${err.message}`);
  process.exitCode = 1;
});
