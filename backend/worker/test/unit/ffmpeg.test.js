import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import {
  assertCapabilities,
  createProgressParser,
  hasFastStart,
  parseXfadeTransitions,
} from '../../src/ffmpeg.js';
import { fullCapabilities, tempDir } from '../helpers/fixtures.js';

test('разбор -progress выдаёт точку на каждый блок', () => {
  const samples = [];
  const push = createProgressParser((s) => samples.push(s));

  push('frame=30\nfps=29.9\nout_time_us=1000000\nprogress=continue\n');
  push('frame=60\nout_time_us=2500000\nprogress=end\n');

  assert.equal(samples.length, 2);
  assert.equal(samples[0].seconds, 1);
  assert.equal(samples[0].frame, 30);
  assert.equal(samples[0].done, false);
  assert.equal(samples[1].seconds, 2.5);
  assert.equal(samples[1].done, true);
});

test('разбор переживает разрыв блока между чанками', () => {
  const samples = [];
  const push = createProgressParser((s) => samples.push(s));

  push('frame=30\nout_ti');
  push('me_us=1500000\nprog');
  push('ress=continue\n');

  assert.equal(samples.length, 1);
  assert.equal(samples[0].seconds, 1.5);
});

test('блок без времени не ломает разбор', () => {
  const samples = [];
  const push = createProgressParser((s) => samples.push(s));
  push('frame=0\nprogress=continue\n');
  assert.equal(samples.length, 1);
  assert.equal(samples[0].seconds, null);
});

test('отсутствие обязательных кодеков — понятная ошибка, а не падение в FFmpeg', () => {
  assert.doesNotThrow(() => assertCapabilities(fullCapabilities()));

  assert.throws(
    () => assertCapabilities(fullCapabilities({ libx264: false })),
    (err) => {
      assert.equal(err.code, 'WORKER_FAILED');
      assert.match(err.detail, /libx264/);
      // Наружу техническая деталь не уходит.
      assert.ok(!err.message.includes('libx264'));
      return true;
    },
  );
});

test('список режимов xfade вычитывается из справки FFmpeg', () => {
  const help = [
    'xfade AVOptions:',
    '  transition        <int>        ..FV....... set cross fade transition (from -1 to 57) (default fade)',
    '     custom          -1           ..FV.......',
    '     fade            0            ..FV.......',
    '     wipeleft        1            ..FV.......',
    '     slideleft       5            ..FV.......',
    '     zoomin          46           ..FV.......',
    '  duration          <duration>   ..FV....... set cross fade duration',
  ].join('\n');

  const transitions = parseXfadeTransitions(help);
  assert.ok(transitions.has('fade'));
  assert.ok(transitions.has('slideleft'));
  assert.ok(transitions.has('zoomin'));
  assert.ok(!transitions.has('duration'), 'следующий параметр не должен попасть в список');
});

test('пустая справка не ломает определение возможностей', () => {
  assert.equal(parseXfadeTransitions('').size, 0);
});

/** Собирает минимальный MP4 из перечисленных боксов. */
function mp4(boxes) {
  const parts = [];
  for (const [type, payload = 0] of boxes) {
    const size = 8 + payload;
    const header = Buffer.alloc(8);
    header.writeUInt32BE(size, 0);
    header.write(type, 4, 'latin1');
    parts.push(header, Buffer.alloc(payload));
  }
  return Buffer.concat(parts);
}

test('faststart: moov перед mdat распознаётся', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'fast.mp4');
  await writeFile(file, mp4([['ftyp', 24], ['moov', 100], ['mdat', 500]]));
  assert.equal(await hasFastStart(file), true);
});

test('faststart: moov после mdat распознаётся как его отсутствие', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'slow.mp4');
  await writeFile(file, mp4([['ftyp', 24], ['mdat', 500], ['moov', 100]]));
  assert.equal(await hasFastStart(file), false);
});

test('faststart: файл без боксов не считается корректным', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'garbage.mp4');
  await writeFile(file, Buffer.alloc(4));
  assert.equal(await hasFastStart(file), false);
});

test('faststart: 64-битный размер бокса разбирается', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'large.mp4');

  const ftyp = Buffer.alloc(16);
  ftyp.writeUInt32BE(1, 0); // размер лежит в 64-битном поле
  ftyp.write('ftyp', 4, 'latin1');
  ftyp.writeBigUInt64BE(24n, 8);

  await writeFile(file, Buffer.concat([ftyp, Buffer.alloc(8), mp4([['moov', 16]])]));
  assert.equal(await hasFastStart(file), true);
});
