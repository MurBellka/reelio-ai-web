import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { DEFAULT_FONT_ID, FONT_CATALOG, FONT_GROUPS, catalogForClient, resolveFont } from '../../src/fonts.js';
import { REPO_ROOT } from '../helpers/fixtures.js';
import { coversText, familyName } from '../helpers/sfnt.js';

const FONTS_DIR = path.join(REPO_ROOT, 'assets/fonts');

/** Кириллица, латиница, цифры и знаки, которые реально встречаются в подписях. */
const REQUIRED_TEXT = 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдеёжзийклмнопрстуфхцчшщъыьэюя';
const LATIN_AND_DIGITS = 'ABCXYZabcxyz0123456789';
const PUNCTUATION = '.,!?:;-—«»()';

test('каждый шрифт каталога есть на диске во всех начертаниях', async () => {
  const present = new Set(await readdir(FONTS_DIR));
  for (const [fontId, entry] of Object.entries(FONT_CATALOG)) {
    for (const [weight, file] of Object.entries(entry.files)) {
      assert.ok(present.has(file), `${fontId}/${weight}: нет файла ${file}`);
    }
  }
});

test('каждый шрифт содержит кириллицу', async () => {
  for (const [fontId, entry] of Object.entries(FONT_CATALOG)) {
    for (const file of new Set(Object.values(entry.files))) {
      const buffer = await readFile(path.join(FONTS_DIR, file));
      const { ok, missing } = coversText(buffer, REQUIRED_TEXT);
      assert.ok(ok, `${fontId} (${file}): нет символов ${missing.slice(0, 8).join('')}`);
    }
  }
});

test('каждый шрифт содержит латиницу, цифры и пунктуацию', async () => {
  for (const [fontId, entry] of Object.entries(FONT_CATALOG)) {
    const buffer = await readFile(path.join(FONTS_DIR, entry.files.regular));
    for (const sample of [LATIN_AND_DIGITS, PUNCTUATION]) {
      const { ok, missing } = coversText(buffer, sample);
      assert.ok(ok, `${fontId}: нет символов ${missing.join('')}`);
    }
  }
});

test('имя семейства в файле совпадает с каталогом — по нему libass ищет шрифт', async () => {
  for (const [fontId, entry] of Object.entries(FONT_CATALOG)) {
    const buffer = await readFile(path.join(FONTS_DIR, entry.files.regular));
    const name = familyName(buffer);
    assert.ok(name, `${fontId}: не удалось прочитать имя семейства`);
    assert.ok(
      name.startsWith(entry.family),
      `${fontId}: в файле «${name}», в каталоге «${entry.family}»`,
    );
  }
});

test('файлы начертаний различаются — вес не подменён синтетическим', async () => {
  for (const [fontId, entry] of Object.entries(FONT_CATALOG)) {
    const unique = new Set(Object.values(entry.files));
    // У Pacifico честно одно начертание, остальные обязаны иметь разные файлы.
    if (fontId === 'pacifico') continue;

    const regular = await readFile(path.join(FONTS_DIR, entry.files.regular));
    const bold = await readFile(path.join(FONTS_DIR, entry.files.bold));
    assert.ok(unique.size >= 2, `${fontId}: все начертания ссылаются на один файл`);
    assert.ok(!regular.equals(bold), `${fontId}: regular и bold — один и тот же файл`);
  }
});

test('у каждого шрифта есть файл лицензии', async () => {
  const present = new Set(await readdir(FONTS_DIR));
  for (const [fontId, entry] of Object.entries(FONT_CATALOG)) {
    const stem = entry.files.regular.split('-')[0];
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
  assert.equal(resolved.family, FONT_CATALOG[DEFAULT_FONT_ID].family);
  assert.match(resolved.note, /^font-fallback:/);
});

test('известный шрифт отдаёт файл нужного начертания без пометки', () => {
  const resolved = resolveFont('montserrat', 'bold');
  assert.equal(resolved.fontId, 'montserrat');
  assert.equal(resolved.family, 'Montserrat');
  assert.equal(resolved.file, 'Montserrat-Bold.ttf');
  assert.equal(resolved.note, null);
});

test('неизвестное начертание откатывается к regular', () => {
  assert.equal(resolveFont('montserrat', 'ultra-heavy').file, 'Montserrat-Regular.ttf');
});

test('каталог для клиента покрывает все четыре группы §5', () => {
  const catalog = catalogForClient();
  assert.equal(catalog.length, Object.keys(FONT_CATALOG).length);
  const groups = new Set(catalog.map((f) => f.group));
  for (const group of FONT_GROUPS) {
    assert.ok(groups.has(group), `в каталоге нет группы ${group}`);
  }
  // Пути к файлам наружу не отдаются — клиенту нужен только идентификатор.
  assert.ok(catalog.every((f) => !('files' in f)));
});
