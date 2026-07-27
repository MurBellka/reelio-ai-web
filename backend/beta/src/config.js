// Конфигурация beta backend'а.
//
// Важное: beta — ОТДЕЛЬНЫЙ сервис со своим адресом. Он не подменяет
// production URL и не читает его переменные. Клиент включает бету явно,
// задавая REELIO_BETA_BACKEND_URL; если она пуста, приложение продолжает
// работать с production и беты просто не видит.
//
// §14: GEMINI_API_KEY читается только из окружения (в облаке — из Secret
// Manager) и никогда не логируется и не отдаётся клиенту.

import { ANALYSIS_QUOTA } from './limits.js';

function int(env, name, fallback) {
  const value = Number.parseInt(env[name] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function bool(env, name, fallback) {
  const raw = (env[name] ?? '').trim().toLowerCase();
  if (raw === '') return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes';
}

export function loadConfig(env = process.env) {
  const appCheckMode = ['off', 'monitor', 'enforce'].includes(env.APP_CHECK_MODE ?? '')
    ? env.APP_CHECK_MODE
    : 'monitor';

  return {
    port: int(env, 'PORT', 8080),
    /** Имя сервиса в /health — чтобы бету нельзя было спутать с production. */
    service: 'reelio-backend-beta',

    firebase: {
      projectId: env.FIREBASE_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT || '',
    },
    auth: {
      appCheckMode,
      /**
       * Разрешает подставлять uid заголовком, когда Firebase не настроен.
       * Только для локальной разработки: в облаке projectId всегда задан, и
       * этот путь недоступен.
       */
      allowInsecureAuth: bool(env, 'ALLOW_INSECURE_AUTH', false),
    },

    gemini: {
      // Ключ здесь НЕ хранится: клиент создаётся из окружения отдельно.
      configured: Boolean(env.GEMINI_API_KEY),
      model: env.GEMINI_MODEL || 'gemini-2.5-flash',
    },

    limits: {
      perUserPerDay: int(env, 'ANALYSES_PER_USER_PER_DAY', ANALYSIS_QUOTA.perUserPerDay),
      perProjectPerDay: int(env, 'ANALYSES_PER_PROJECT_PER_DAY', ANALYSIS_QUOTA.perProjectPerDay),
      maxActiveAnalyses: int(env, 'MAX_ACTIVE_ANALYSES', 2),
    },

    cors: {
      allowedOrigins: new Set(
        (env.BETA_ALLOWED_ORIGINS || 'https://murbellka.github.io,http://localhost:5353')
          .split(',')
          .map((o) => o.trim())
          .filter(Boolean),
      ),
    },

    storage: {
      bucket: env.BETA_MEDIA_BUCKET || '',
      localRoot: env.LOCAL_MEDIA_ROOT || '',
    },
  };
}

/** Снимок для /health — без секретов и без адресов. */
export function healthSnapshot(config) {
  return {
    ok: true,
    service: config.service,
    contractVersion: 2,
    analysis: {
      configured: config.gemini.configured,
      model: config.gemini.configured ? config.gemini.model : null,
    },
    appCheck: config.auth.appCheckMode,
  };
}
