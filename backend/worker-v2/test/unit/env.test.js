import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadEnv } from '../../src/env.js';
import { redact } from '../../src/logger.js';

const CLOUD_ENV = {
  REELIO_JOB_ID: 'job_01J8ABC',
  REELIO_PROJECT_ID: 'proj_9d1',
  REELIO_BUCKET: 'reelio-render-eu',
  REELIO_PLAN_URI: 'gs://reelio-render-eu/projects/proj_9d1/jobs/job_01J8ABC/plan.json',
  REELIO_OUTPUT_PREFIX: 'projects/proj_9d1/jobs/job_01J8ABC/output',
  REELIO_PROGRESS_URL: 'https://api.example/internal/jobs/job_01J8ABC/progress',
  REELIO_WORKER_TOKEN: 'token-from-secret-manager',
  REELIO_CONTRACT_VERSION: '1',
};

test('переменные Cloud Run Job (§9) разбираются в конфигурацию', () => {
  const env = loadEnv(CLOUD_ENV);
  assert.equal(env.mode, 'cloud');
  assert.equal(env.jobId, 'job_01J8ABC');
  assert.equal(env.projectId, 'proj_9d1');
  assert.equal(env.bucket, 'reelio-render-eu');
  assert.equal(env.planObjectPath, 'projects/proj_9d1/jobs/job_01J8ABC/plan.json');
  assert.equal(env.outputPrefix, 'projects/proj_9d1/jobs/job_01J8ABC/output');
  assert.equal(env.contractVersion, 1);
});

test('local mode распознаётся по схеме file:// (§10)', () => {
  const env = loadEnv({
    ...CLOUD_ENV,
    REELIO_PLAN_URI: 'file:///srv/.render-local/projects/proj_9d1/jobs/job_01J8ABC/plan.json',
    REELIO_PROGRESS_URL: 'http://127.0.0.1:8080/internal/jobs/job_01J8ABC/progress',
  });
  assert.equal(env.mode, 'local');
  assert.equal(env.localRoot, '/srv/.render-local');
  assert.equal(env.planObjectPath, 'projects/proj_9d1/jobs/job_01J8ABC/plan.json');
});

test('токен worker\'а сразу становится секретом логгера', () => {
  loadEnv(CLOUD_ENV);
  assert.ok(!redact('в логе token-from-secret-manager').includes('token-from-secret-manager'));
});

test('без обязательной переменной запуск отклоняется с указанием поля', () => {
  for (const key of ['REELIO_JOB_ID', 'REELIO_PROJECT_ID', 'REELIO_PLAN_URI', 'REELIO_OUTPUT_PREFIX']) {
    const broken = { ...CLOUD_ENV };
    delete broken[key];
    assert.throws(
      () => loadEnv(broken),
      (err) => {
        assert.equal(err.field, key);
        return true;
      },
      `отсутствие ${key} должно быть ошибкой`,
    );
  }
});

test('умолчания заданы для всего, что не приходит из §9', () => {
  const env = loadEnv(CLOUD_ENV);
  assert.equal(env.ffmpegPath, 'ffmpeg');
  assert.equal(env.ffprobePath, 'ffprobe');
  assert.equal(env.fitMode, 'cover');
  assert.equal(env.keepTmp, false);
  assert.equal(env.uploadLog, true);
  // Heartbeat заведомо чаще требуемых контрактом 30 с (§4.2).
  assert.ok(env.heartbeatMs <= 30_000);
});

test('неизвестный режим кадрирования откатывается к умолчанию', () => {
  assert.equal(loadEnv({ ...CLOUD_ENV, REELIO_FIT_MODE: 'stretch' }).fitMode, 'cover');
  assert.equal(loadEnv({ ...CLOUD_ENV, REELIO_FIT_MODE: 'contain' }).fitMode, 'contain');
});

test('завершающий слэш в префиксе вывода отбрасывается', () => {
  const env = loadEnv({ ...CLOUD_ENV, REELIO_OUTPUT_PREFIX: 'projects/proj_9d1/jobs/job_1/output/' });
  assert.equal(env.outputPrefix, 'projects/proj_9d1/jobs/job_1/output');
});
