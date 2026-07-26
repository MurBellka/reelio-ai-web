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

  // Лимиты запросов в минуту на IP. Значения по умолчанию — из контракта §8.
  rateLimits: {
    editPlan: int('RATE_LIMIT_EDIT_PLAN', 20),
    render: int('RATE_LIMIT_RENDER', 10),
    // Отмена намеренно щедрее создания: см. комментарий в routes.js.
    cancel: int('RATE_LIMIT_CANCEL', 60),
    poll: int('RATE_LIMIT_POLL', 240),
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
    //
    // trim обязателен: секрет, созданный из `openssl rand … | gcloud secrets
    // create --data-file=-`, содержит хвостовой \n. Он не переживает передачу
    // в HTTP-заголовке Authorization, поэтому worker и backend видели бы
    // разные значения и получали вечный 401.
    workerToken: (process.env.WORKER_TOKEN || '').trim() || randomBytes(24).toString('hex'),
  },
};

/** Безопасный снимок конфигурации для /health — без секретов. */
export function healthSnapshot(cfg = config) {
  return {
    ok: true,
    service: 'reelio-backend',
    contractVersion: 1,
    demo: !cfg.gemini.apiKey,
    render: {
      configured: cfg.render.mode === 'cloud',
      mode: cfg.render.mode,
    },
  };
}
