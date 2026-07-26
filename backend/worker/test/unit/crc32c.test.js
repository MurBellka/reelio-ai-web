import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Crc32c, crc32c, crc32cBase64 } from '../../src/crc32c.js';

test('crc32c совпадает с эталонным вектором Castagnoli', () => {
  assert.equal(crc32c(Buffer.from('123456789')), 0xe3069283);
});

test('пустой вход даёт нулевую сумму', () => {
  assert.equal(crc32c(Buffer.alloc(0)), 0);
});

test('инкрементальный расчёт совпадает с разовым', () => {
  const data = Buffer.from('вертикальный ролик 9:16 с музыкой и субтитрами', 'utf8');
  const streamed = new Crc32c();
  streamed.update(data.subarray(0, 7));
  streamed.update(data.subarray(7, 20));
  streamed.update(data.subarray(20));
  assert.equal(streamed.value(), crc32c(data));
});

test('base64 — big-endian uint32, как в метаданных GCS', () => {
  const b64 = crc32cBase64(Buffer.from('123456789'));
  assert.equal(Buffer.from(b64, 'base64').readUInt32BE(0), 0xe3069283);
  assert.equal(b64, Buffer.from([0xe3, 0x06, 0x92, 0x83]).toString('base64'));
});
