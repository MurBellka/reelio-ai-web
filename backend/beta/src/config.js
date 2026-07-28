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

/**
 * Режим исполнения. В облаке Cloud Run выставляет `K_SERVICE`; его наличие —
 * самый надёжный признак, что мы не на localhost. `REELIO_RUNTIME` позволяет
 * форсировать режим в тестах и в эмуляторе.
 */
export function detectMode(env = process.env) {
  const forced = (env.REELIO_RUNTIME || '').trim().toLowerCase();
  if (forced === 'cloud' || forced === 'local') return forced;
  return env.K_SERVICE ? 'cloud' : 'local';
}

export function loadConfig(env = process.env) {
  const appCheckMode = ['off', 'monitor', 'enforce'].includes(env.APP_CHECK_MODE ?? '')
    ? env.APP_CHECK_MODE
    : 'monitor';

  const mode = detectMode(env);
  const projectId = env.FIREBASE_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT || '';

  return {
    port: int(env, 'PORT', 8080),
    /** Имя сервиса в /health — чтобы бету нельзя было спутать с production. */
    service: 'reelio-backend-beta',
    mode,

    /**
     * Хранилище состояния. В облаке — только Firestore: MemoryStore в
     * multi-instance Cloud Run теряет квоты, кэш и идемпотентность (§4A.5).
     */
    storeKind: (env.REELIO_STORE || (mode === 'cloud' ? 'firestore' : 'memory')).toLowerCase(),

    firebase: {
      projectId,
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
      // Один бакет v2: и для медиа (users/{uid}/…), и для результатов рендера.
      bucket: env.REELIO_RENDER_BUCKET || env.BETA_MEDIA_BUCKET || '',
      localRoot: env.LOCAL_MEDIA_ROOT || '',
      /** Срок жизни подписанной ссылки на скачивание/загрузку, секунды. */
      signedUrlTtlSeconds: int(env, 'SIGNED_URL_TTL_SECONDS', 900),
    },

    // §4A.7 — долговечное выполнение через Cloud Tasks.
    tasks: {
      queue: env.CLOUD_TASKS_QUEUE || '',
      location: env.CLOUD_TASKS_LOCATION || env.RENDER_JOB_REGION || 'europe-west1',
      /** Абсолютный URL внутреннего endpoint'а, который дёргает Cloud Tasks. */
      internalUrl: env.INTERNAL_BASE_URL || '',
      /** SA, от имени которого Cloud Tasks подписывает OIDC-токен. */
      invokerServiceAccount: env.TASKS_INVOKER_SA || '',
    },

    // §4B.4 — запуск Cloud Run Job worker-v2.
    render: {
      // Никогда не worker v1: имя жёстко проверяется на префикс v2.
      workerJobName: env.RENDER_JOB_NAME_V2 || 'reelio-ffmpeg-worker-v2',
      workerJobRegion: env.RENDER_JOB_REGION || 'europe-west1',
      projectId,
      /** Токен канала прогресса worker'а (§8.1). */
      workerToken: env.REELIO_WORKER_TOKEN || '',
      /** Публичный базовый URL beta для callback'а прогресса worker'а. */
      publicBaseUrl: env.PUBLIC_BASE_URL || '',
      /** Через сколько дней истекает результат рендера (§6). */
      resultTtlDays: int(env, 'RENDER_RESULT_TTL_DAYS', 7),
    },
  };
}

/** Снимок для /health — без секретов и без адресов. */
export function healthSnapshot(config) {
  return {
    ok: true,
    service: config.service,
    apiVersion: 2,
    contractVersion: 2,
    renderContractVersion: 2,
    authRequired: true,
    mode: config.mode,
    analysis: {
      configured: config.gemini.configured,
      model: config.gemini.configured ? config.gemini.model : null,
    },
    render: {
      // Готов принимать рендер только когда есть бакет, очередь и имя Job'а.
      configured: Boolean(config.storage.bucket && config.render.workerJobName),
      worker: config.render.workerJobName,
    },
    appCheck: config.auth.appCheckMode,
  };
}
