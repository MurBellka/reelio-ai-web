// Конфигурация backend'а. Все значения — из переменных окружения.
// Секреты (GEMINI_API_KEY, токен worker'а) никогда не логируются и не
// возвращаются клиенту.

import { randomBytes } from 'node:crypto';

function int(name, fallback) {
  const raw = process.env[name];
  const value = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const bucket = process.env.RENDER_BUCKET || '';
const jobName = process.env.RENDER_JOB_NAME || '';

/** cloud — Firestore + GCS + Cloud Run Job; local — память + файлы (§10). */
export const RENDER_MODE = bucket && jobName ? 'cloud' : 'local';

export const config = {
  port: int('PORT', 8080),

  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  },

  allowedOrigins: new Set(
    [
      process.env.ALLOWED_ORIGIN || 'https://murbellka.github.io',
      'http://localhost:5353',
      'http://127.0.0.1:5353',
      'http://localhost:8080',
    ].filter(Boolean),
  ),

  render: {
    mode: RENDER_MODE,
    bucket,
    gcpProject: process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT || '',
    firestoreDatabase: process.env.FIRESTORE_DATABASE || '(default)',
    jobName,
    jobRegion: process.env.RENDER_JOB_REGION || 'europe-west1',
    signedUrlTtlSeconds: int('SIGNED_URL_TTL_SECONDS', 3600),
    jobTtlDays: int('JOB_TTL_DAYS', 7),
    heartbeatTimeoutMs: int('WORKER_HEARTBEAT_TIMEOUT_SECONDS', 600) * 1000,
    localRoot: process.env.LOCAL_RENDER_ROOT || '.render-local',
    localWorkerCmd: process.env.LOCAL_WORKER_CMD || '',
    // Публичный базовый URL сервиса — нужен worker'у для отчётов о прогрессе.
    publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
    // Общий секрет worker → backend. В облаке задаётся через Secret Manager.
    // Локально генерируется на старте (никуда не пишется, только в env job'а).
    workerToken: process.env.WORKER_TOKEN || randomBytes(24).toString('hex'),
  },
};

/** Безопасный снимок конфигурации для /health — без секретов. */
export function healthSnapshot() {
  return {
    ok: true,
    service: 'reelio-backend',
    contractVersion: 1,
    demo: !config.gemini.apiKey,
    render: {
      configured: RENDER_MODE === 'cloud',
      mode: RENDER_MODE,
    },
  };
}
