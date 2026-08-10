// Безопасный структурированный логгер (§ безопасные логи): секреты, токены,
// signed URL, objectPath, uid, email, содержимое — НЕ попадают в лог.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLogger } from '../../src/logger.js';

/** Перехватывает console.log и возвращает распарсенные записи. */
function capture(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (s) => lines.push(s);
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return lines.map((l) => JSON.parse(l));
}

test('логгер пишет безопасные поля и severity, message', () => {
  const [rec] = capture(() => {
    createLogger().warn('analysis failed', { jobId: 'an_1', errorCode: 'MEDIA_PROBE_FAILED', stage: 'probing', retryable: true });
  });
  assert.equal(rec.severity, 'WARNING');
  assert.equal(rec.message, 'analysis failed');
  assert.equal(rec.jobId, 'an_1');
  assert.equal(rec.errorCode, 'MEDIA_PROBE_FAILED');
  assert.equal(rec.stage, 'probing');
  assert.equal(rec.retryable, true);
  assert.ok(rec.timestamp);
});

test('логгер РЕДАКТИРУЕТ секреты, токены, signed URL, objectPath, uid, email, gemini', () => {
  const secret = 'AIzaSyDsupersecretkey1234567890';
  const [rec] = capture(() => {
    createLogger().error('boom', {
      jobId: 'an_2',
      authorization: `Bearer ${secret}`,
      idToken: secret,
      appCheckToken: secret,
      apiKey: secret,
      objectPath: 'users/uabc/projects/p1/sources/a.mp4',
      uid: 'uabc',
      email: 'person@example.com',
      signedUrl: 'https://storage.googleapis.com/x?X-Goog-Signature=deadbeef',
      downloadUrl: 'https://x/y?sig=1',
      gemini: 'raw model output text',
      filePath: '/tmp/reelio-an-xyz/source.bin',
      nested: { token: secret, safe: 'ok' },
    });
  });
  const blob = JSON.stringify(rec);
  assert.ok(!blob.includes(secret), 'секрет не в логе');
  assert.ok(!blob.includes('person@example.com'), 'email не в логе');
  assert.ok(!blob.includes('users/uabc/projects'), 'objectPath не в логе');
  assert.ok(!blob.includes('X-Goog-Signature'), 'signed URL не в логе');
  assert.ok(!blob.includes('reelio-an-xyz'), 'локальный путь не в логе');
  assert.ok(!blob.includes('raw model output'), 'сырой Gemini не в логе');
  // безопасные поля сохранены
  assert.equal(rec.jobId, 'an_2');
  assert.equal(rec.authorization, '[redacted]');
  assert.equal(rec.uid, '[redacted]');
  assert.equal(rec.email, '[redacted]');
  assert.equal(rec.nested.token, '[redacted]');
  assert.equal(rec.nested.safe, 'ok');
});

test('логгер укорачивает слишком длинные строки', () => {
  const long = 'x'.repeat(5000);
  const [rec] = capture(() => createLogger().info('long', { detail: long }));
  assert.ok(rec.detail.length < 600, 'длинная строка укорочена');
});
