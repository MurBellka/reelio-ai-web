import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { SYNTH_TRACKS, findTrackFile, resolveMusicInput, synthExpression } from '../../src/music.js';
import { tempDir } from '../helpers/fixtures.js';

test('track "none" не даёт источника музыки', async () => {
  assert.equal(await resolveMusicInput({ track: 'none', musicDir: '/nowhere', duration: 10 }), null);
});

test('файл трека в каталоге образа имеет приоритет над синтезом', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'chill.m4a');
  await writeFile(file, 'не настоящий звук, важен сам факт наличия файла');

  assert.equal(await findTrackFile(dir, 'chill'), file);

  const input = await resolveMusicInput({ track: 'chill', musicDir: dir, duration: 10 });
  assert.equal(input.kind, 'file');
  assert.deepEqual(input.inputArgs, ['-stream_loop', '-1', '-i', file]);
});

test('без файла трека подложка синтезируется через lavfi', async () => {
  const input = await resolveMusicInput({ track: 'energy', musicDir: '/nowhere', duration: 12.5 });
  assert.equal(input.kind, 'synth');
  assert.deepEqual(input.inputArgs.slice(0, 3), ['-f', 'lavfi', '-i']);
  assert.match(input.inputArgs[3], /^aevalsrc=exprs=/);
  assert.match(input.inputArgs[3], /sample_rate=48000/);
  assert.match(input.inputArgs[3], /duration=12\.500/);
});

test('выражение синтеза не содержит запятых — иначе развалится парсер фильтров', () => {
  for (const [name, spec] of Object.entries(SYNTH_TRACKS)) {
    const expr = synthExpression(spec, 10);
    assert.ok(!expr.includes(','), `трек ${name}: запятая в выражении`);
    assert.ok(!expr.includes(' '), `трек ${name}: пробел в выражении`);
  }
});

test('у каналов разная расстройка — подложка стереофоническая', async () => {
  const input = await resolveMusicInput({ track: 'chill', musicDir: '/nowhere', duration: 8 });
  const [left, right] = /exprs=([^:]+)/.exec(input.inputArgs[3])[1].split('|');
  assert.notEqual(left, right);
});

test('выражение содержит плавные вход и выход по длительности ролика', () => {
  const expr = synthExpression(SYNTH_TRACKS.cinematic, 20);
  assert.match(expr, /\(1-exp\(-t\/0\.6\)\)/);
  assert.match(expr, /20\.000-t/);
});

test('неизвестный трек не роняет рендер, а откатывается к умолчанию', async () => {
  const input = await resolveMusicInput({ track: 'нет-такого', musicDir: '/nowhere', duration: 5 });
  assert.equal(input.kind, 'synth');
});

test('все треки контракта имеют параметры синтеза', () => {
  for (const track of ['chill', 'energy', 'cinematic', 'trending']) {
    assert.ok(SYNTH_TRACKS[track], `нет параметров для трека ${track}`);
    assert.ok(SYNTH_TRACKS[track].chord.length === 3);
    assert.ok(SYNTH_TRACKS[track].gain > 0 && SYNTH_TRACKS[track].gain < 1);
  }
});
