// Переменные окружения Cloud Run Job (§9 контракта) и локального режима (§10).
//
// Один и тот же код обязан работать в обоих режимах; различаем их по схеме
// REELIO_PLAN_URI: gs:// → cloud, file:// → local.

import { WorkerError } from './errors.js';
import { registerSecret } from './logger.js';

function required(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WorkerError('INVALID_REQUEST', 'Рендер запущен без обязательных параметров.', {
      field: name,
      detail: `missing env ${name}`,
    });
  }
  return value.trim();
}

function int(env, name, fallback) {
  const value = Number.parseInt(env[name] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function bool(env, name, fallback) {
  const raw = (env[name] ?? '').trim().toLowerCase();
  if (raw === '') return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/** Разбирает REELIO_PLAN_URI в режим и локальный/облачный адрес плана. */
export function parsePlanUri(planUri) {
  if (planUri.startsWith('gs://')) {
    const rest = planUri.slice('gs://'.length);
    const slash = rest.indexOf('/');
    if (slash <= 0 || slash === rest.length - 1) {
      throw new WorkerError('INVALID_REQUEST', 'Некорректный адрес монтажного плана.', {
        field: 'REELIO_PLAN_URI',
        detail: 'malformed gs:// uri',
      });
    }
    return { mode: 'cloud', bucket: rest.slice(0, slash), objectPath: rest.slice(slash + 1) };
  }

  if (planUri.startsWith('file://')) {
    // file:///abs/path/projects/{p}/jobs/{j}/plan.json — корень локального
    // «бакета» получаем, отрезав относительный путь объекта (§10).
    const filePath = decodeURIComponent(planUri.slice('file://'.length));
    // Схема путей задаётся backend'ом: users/{uid}/projects/… либо projects/….
    // Корень локального «бакета» — всё, что до первого из этих сегментов.
    let at = filePath.indexOf('/users/');
    if (at < 0) at = filePath.lastIndexOf('/projects/');
    if (at < 0) {
      throw new WorkerError('INVALID_REQUEST', 'Некорректный адрес монтажного плана.', {
        field: 'REELIO_PLAN_URI',
        detail: 'file uri without projects/ segment',
      });
    }
    return {
      mode: 'local',
      root: filePath.slice(0, at),
      objectPath: filePath.slice(at + 1),
    };
  }

  throw new WorkerError('INVALID_REQUEST', 'Неподдерживаемый адрес монтажного плана.', {
    field: 'REELIO_PLAN_URI',
    detail: 'unsupported uri scheme',
  });
}

/**
 * Полная конфигурация запуска. Токен регистрируется как секрет сразу, чтобы он
 * не мог просочиться в лог даже при неожиданной ошибке ниже по стеку.
 */
export function loadEnv(env = process.env) {
  const jobId = required(env, 'REELIO_JOB_ID');
  const projectId = required(env, 'REELIO_PROJECT_ID');
  const planUri = required(env, 'REELIO_PLAN_URI');
  const outputPrefix = required(env, 'REELIO_OUTPUT_PREFIX');

  // trim: значение из Secret Manager может нести хвостовой \n (типично для
  // `openssl rand … | gcloud secrets create --data-file=-`). В заголовке
  // Authorization он не выживает, и backend отвечал бы 401 на каждый отчёт.
  const workerToken = (env.REELIO_WORKER_TOKEN || '').trim();
  registerSecret(workerToken);

  // Префиксы задаёт backend (в них зашит проверенный uid владельца). Значения
  // по умолчанию сохраняют совместимость со старой схемой путей.
  const projectPrefix = env.REELIO_PROJECT_PREFIX || `projects/${projectId}/`;
  const jobPrefix = env.REELIO_JOB_PREFIX || `${projectPrefix}jobs/${jobId}/`;

  const contractVersion = int(env, 'REELIO_CONTRACT_VERSION', 1);
  const plan = parsePlanUri(planUri);

  return {
    jobId,
    projectId,
    projectPrefix,
    jobPrefix,
    contractVersion,
    mode: plan.mode,
    bucket: plan.mode === 'cloud' ? plan.bucket : env.REELIO_BUCKET || '',
    localRoot: plan.mode === 'local' ? plan.root : '',
    planObjectPath: plan.objectPath,
    outputPrefix: outputPrefix.replace(/\/+$/, ''),

    progressUrl: env.REELIO_PROGRESS_URL || '',
    workerToken,

    // Инструменты и ресурсы образа.
    ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
    ffprobePath: env.FFPROBE_PATH || 'ffprobe',
    // Каталог шрифтов §5: те же файлы, что использует web-превью.
    fontsDir: env.REELIO_FONTS_DIR || '/usr/share/fonts/truetype/reelio',

    // Поведение пайплайна.
    workDir: env.REELIO_WORK_DIR || '',
    fitMode: ['cover', 'contain', 'blur'].includes(env.REELIO_FIT_MODE ?? '')
      ? env.REELIO_FIT_MODE
      : 'cover',
    preset: env.REELIO_X264_PRESET || 'medium',
    heartbeatMs: int(env, 'REELIO_HEARTBEAT_SECONDS', 15) * 1000,
    keepTmp: bool(env, 'REELIO_KEEP_TMP', false),
    uploadLog: bool(env, 'REELIO_UPLOAD_LOG', true),
    logLevel: env.REELIO_LOG_LEVEL || 'info',
  };
}
