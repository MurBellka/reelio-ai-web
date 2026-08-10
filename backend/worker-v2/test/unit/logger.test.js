import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Logger, redact, registerSecret } from '../../src/logger.js';

function capture() {
  const lines = [];
  const logger = new Logger({ level: 'debug', sink: (line) => lines.push(line) });
  return { logger, lines, parsed: () => lines.map((l) => JSON.parse(l)) };
}

test('подписанный URL не попадает в лог (§8)', () => {
  const url =
    'https://storage.googleapis.com/bucket/reel.mp4?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=deadbeef';
  assert.equal(redact(url), '<signed-url>');
  assert.ok(!redact(`ссылка: ${url}`).includes('deadbeef'));
});

test('bearer-токен вырезается из произвольного текста', () => {
  assert.equal(redact('Authorization: Bearer abcdef1234567890'), 'Authorization: Bearer ***');
});

test('зарегистрированный секрет исчезает из всех полей записи', () => {
  registerSecret('super-secret-worker-token');
  const { logger, parsed } = capture();

  logger.info('token is super-secret-worker-token', { detail: 'super-secret-worker-token here' });

  const entry = parsed()[0];
  assert.ok(!entry.message.includes('super-secret-worker-token'));
  assert.ok(!entry.detail.includes('super-secret-worker-token'));
  assert.match(entry.message, /\*\*\*/);
});

test('короткие строки секретами не считаются — иначе вычистим весь лог', () => {
  registerSecret('abc');
  assert.equal(redact('abc def'), 'abc def');
});

test('контекст задачи добавляется к каждой записи', () => {
  const { logger, parsed } = capture();
  logger.withContext({ jobId: 'job_1', projectId: 'proj_1' });
  logger.info('первая');
  logger.warn('вторая');

  for (const entry of parsed()) {
    assert.equal(entry.jobId, 'job_1');
    assert.equal(entry.projectId, 'proj_1');
  }
});

test('уровень фильтрует менее важные записи', () => {
  const lines = [];
  const logger = new Logger({ level: 'warn', sink: (l) => lines.push(l) });
  logger.debug('не видно');
  logger.info('тоже не видно');
  logger.warn('видно');
  logger.error('видно');
  assert.equal(lines.length, 2);
});

test('каждая запись — валидный JSON со временем и уровнем', () => {
  const { logger, parsed } = capture();
  logger.error('сбой', { code: 'WORKER_FAILED' });
  const entry = parsed()[0];
  assert.equal(entry.severity, 'ERROR');
  assert.equal(entry.code, 'WORKER_FAILED');
  assert.ok(!Number.isNaN(Date.parse(entry.time)));
});

test('буфер worker.log обрезается и помечается', () => {
  const logger = new Logger({ level: 'debug', maxBufferBytes: 300, sink: () => {} });
  for (let i = 0; i < 50; i += 1) logger.info(`строка номер ${i} с довольно длинным текстом`);
  const dump = logger.dump();
  assert.ok(dump.includes('log truncated'));
  assert.ok(dump.length < 1000);
});
