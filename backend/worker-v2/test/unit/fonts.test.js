import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import {
  DEFAULT_FONT_ID,
  FONT_CATALOG,
  FONT_GROUPS,
  FONT_WEIGHTS,
  catalogForClient,
  resolveFont,
} from '../../src/fonts.js';
import { REPO_ROOT } from '../helpers/fixtures.js';
import { coversText, familyName, nameStrings } from '../helpers/sfnt.js';

const FONTS_DIR = path.join(REPO_ROOT, 'assets/fonts');

/** Кириллица, латиница, цифры и знаки, которые реально встречаются в подписях. */
const REQUIRED_TEXT = 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдеёжзийклмнопрстуфхцчшщъыьэюя';
const LATIN_AND_DIGITS = 'ABCXYZabcxyz0123456789';
const PUNCTUATION = '.,!?:;-—«»()';

/** Все файлы начертаний семейства (без повторов). */
function filesOf(entry) {
  return new Set(Object.values(entry.weights).map((w) => w.file));
}

test('каждый шрифт каталога есть на диске во всех начертаниях', async () => {
  const present = new Set(await readdir(FONTS_DIR));
  for (const [fontId, entry] of Object.entries(FONT_CATALOG)) {
    for (const [weight, w] of Object.entries(entry.weights)) {
      assert.ok(present.has(w.file), `${fontId}/${weight}: нет файла ${w.file}`);
    }
  }
});

test('каждое семейство поддерживает regular, medium и bold', () => {
  for (const [fontId, entry] of Object.entries(FONT_CATALOG)) {
    for (const weight of FONT_WEIGHTS) {
      assert.ok(Object.hasOwn(entry.weights, weight), `${fontId}: нет начертания ${weight}`);
    }
  }
});

test('каждый шрифт содержит кириллицу', async () => {
  for (const [fontId, entry] of Object.entries(FONT_CATALOG)) {
    for (const file of filesOf(entry)) {
      const buffer = await readFile(path.join(FONTS_DIR, file));
      const { ok, missing } = coversText(buffer, REQUIRED_TEXT);
      assert.ok(ok, `${fontId} (${file}): нет символов ${missing.slice(0, 8).join('')}`);
    }
  }
});

test('каждый шрифт содержит латиницу, цифры и пунктуацию', async () => {
  for (const [fontId, entry] of Object.entries(FONT_CATALOG)) {
    const buffer = await readFile(path.join(FONTS_DIR, entry.weights.regular.file));
    for (const sample of [LATIN_AND_DIGITS, PUNCTUATION]) {
      const { ok, missing } = coversText(buffer, sample);
      assert.ok(ok, `${fontId}: нет символов ${missing.join('')}`);
    }
  }
});

test('resolveFont возвращает имя семейства, реально записанное в выбранном TTF', async () => {
  // Именно по этому имени libass находит файл. Если бы medium ссылался на
  // базовое «Montserrat», libass молча взял бы Regular — тест это ловит.
  for (const [fontId, entry] of Object.entries(FONT_CATALOG)) {
    for (const weight of FONT_WEIGHTS) {
      const resolved = resolveFont(fontId, weight);
      const buffer = await readFile(path.join(FONTS_DIR, resolved.file));
      const names = nameStrings(buffer);
      assert.ok(
        names.has(resolved.family),
        `${fontId}/${weight}: resolveFont даёт «${resolved.family}», ` +
          `а в ${resolved.file} есть только [${[...names].join(', ')}]`,
      );
    }
  }
});

test('Medium не подменяется Regular у семейств с отдельным Medium', () => {
  for (const [fontId, entry] of Object.entries(FONT_CATALOG)) {
    const medium = entry.weights.medium;
    if (medium.fallbackFrom) continue; // pt_sans, pacifico — честный откат
    assert.notEqual(
      medium.file,
      entry.weights.regular.file,
      `${fontId}: medium ссылается на файл regular`,
    );
    assert.notEqual(
      medium.family,
      entry.weights.regular.family,
      `${fontId}: у medium то же имя семейства, что у regular — libass возьмёт Regular`,
    );
    const resolved = resolveFont(fontId, 'medium');
    assert.equal(resolved.file, medium.file);
    assert.equal(resolved.note, null, `${fontId}: у настоящего medium не должно быть пометки отката`);
  }
});

test('Medium без отдельного файла откатывается на Regular с пометкой (не на Bold)', () => {
  for (const [fontId, entry] of Object.entries(FONT_CATALOG)) {
    if (!entry.weights.medium.fallbackFrom) continue;
    const resolved = resolveFont(fontId, 'medium');
    assert.equal(resolved.file, entry.weights.regular.file, `${fontId}: medium должен падать на regular`);
    // Проверяем «не на Bold» только там, где Bold — отдельный файл (PT Sans).
    // У Pacifico honestly одно начертание, и все веса ссылаются на него же.
    if (!entry.weights.bold.fallbackFrom) {
      assert.notEqual(resolved.file, entry.weights.bold.file, `${fontId}: medium не должен падать на bold`);
    }
    assert.match(resolved.note, /font-weight-fallback/, `${fontId}: откат обязан быть задокументирован`);
  }
});

test('regular и bold — разные файлы (вес не синтетический)', async () => {
  for (const [fontId, entry] of Object.entries(FONT_CATALOG)) {
    if (fontId === 'pacifico') continue; // честно одно начертание
    const regular = await readFile(path.join(FONTS_DIR, entry.weights.regular.file));
    const bold = await readFile(path.join(FONTS_DIR, entry.weights.bold.file));
    assert.ok(!regular.equals(bold), `${fontId}: regular и bold — один и тот же файл`);
  }
});

test('имя базового семейства в файле совпадает с каталогом', async () => {
  for (const [fontId, entry] of Object.entries(FONT_CATALOG)) {
    const buffer = await readFile(path.join(FONTS_DIR, entry.weights.regular.file));
    const name = familyName(buffer);
    assert.ok(name && name.startsWith(entry.family), `${fontId}: в файле «${name}», в каталоге «${entry.family}»`);
  }
});

test('у каждого шрифта есть файл лицензии', async () => {
  const present = new Set(await readdir(FONTS_DIR));
  for (const [fontId, entry] of Object.entries(FONT_CATALOG)) {
    const stem = entry.weights.regular.file.split('-')[0];
    assert.ok(present.has(`${stem}-LICENSE.txt`), `${fontId}: нет файла лицензии`);
  }
});

test('лицензии — только OFL или Apache, как требует §5', () => {
  for (const [fontId, entry] of Object.entries(FONT_CATALOG)) {
    assert.match(entry.license, /^(OFL-1\.1|Apache-2\.0)$/, `${fontId}: ${entry.license}`);
  }
});

test('неизвестный шрифт откатывается к умолчанию с пометкой', () => {
  const resolved = resolveFont('comic-sans-3000', 'bold');
  assert.equal(resolved.fontId, DEFAULT_FONT_ID);
  assert.equal(resolved.family, FONT_CATALOG[DEFAULT_FONT_ID].weights.bold.family);
  assert.match(resolved.note, /^font-fallback:/);
});

test('известный шрифт отдаёт файл нужного начертания без пометки', () => {
  const bold = resolveFont('montserrat', 'bold');
  assert.equal(bold.fontId, 'montserrat');
  assert.equal(bold.family, 'Montserrat');
  assert.equal(bold.file, 'Montserrat-Bold.ttf');
  assert.equal(bold.note, null);

  const medium = resolveFont('montserrat', 'medium');
  assert.equal(medium.family, 'Montserrat Medium');
  assert.equal(medium.file, 'Montserrat-Medium.ttf');
  assert.equal(medium.note, null);
});

test('неизвестное начертание откатывается к regular', () => {
  const resolved = resolveFont('montserrat', 'ultra-heavy');
  assert.equal(resolved.file, 'Montserrat-Regular.ttf');
  assert.match(resolved.note, /font-weight-fallback/);
});

test('каталог для клиента покрывает все четыре группы §5', () => {
  const catalog = catalogForClient();
  assert.equal(catalog.length, Object.keys(FONT_CATALOG).length);
  const groups = new Set(catalog.map((f) => f.group));
  for (const group of FONT_GROUPS) {
    assert.ok(groups.has(group), `в каталоге нет группы ${group}`);
  }
  // Каждый шрифт отдаёт логические начертания, но не пути к файлам.
  for (const f of catalog) {
    assert.deepEqual(f.weights, FONT_WEIGHTS);
    assert.ok(!('files' in f), `${f.fontId}: клиенту утекли пути к файлам`);
  }
});
