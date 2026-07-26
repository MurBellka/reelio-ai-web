// Реализация контракта docs/render-contract.md v1: разрешения, состояния,
// валидация RenderRequest/EditPlan, канонизация для идемпотентности.

import { createHash, randomBytes } from 'node:crypto';
import { ApiError } from './errors.js';

export const CONTRACT_VERSION = 1;

/** Потолок продукта: вертикальный ролик до 2 минут. */
export const MAX_DURATION_SECONDS = 120;
export const MAX_CLIPS = 60;
export const MAX_ACTIVE_JOBS_PER_PROJECT = 2;

/** §1 — разрешения 9:16. */
export const RESOLUTIONS = {
  hd720: { label: '720p', width: 720, height: 1280, videoBitrateKbps: 4000, maxrateKbps: 5000, audioBitrateKbps: 128, level: '4.0' },
  fullHd1080: { label: '1080p', width: 1080, height: 1920, videoBitrateKbps: 8000, maxrateKbps: 10000, audioBitrateKbps: 160, level: '4.2' },
  twoK1440: { label: '2K', width: 1440, height: 2560, videoBitrateKbps: 16000, maxrateKbps: 20000, audioBitrateKbps: 192, level: '5.0' },
  fourK2160: { label: '4K', width: 2160, height: 3840, videoBitrateKbps: 35000, maxrateKbps: 45000, audioBitrateKbps: 192, level: '5.1' },
};

/** Конкретные разрешения по возрастанию высоты. */
export const CONCRETE_RESOLUTIONS = ['hd720', 'fullHd1080', 'twoK1440', 'fourK2160'];
export const AUTO_RESOLUTION = 'maximumAvailable';
export const ALLOWED_FPS = [30, 60];

export const STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'];
export const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

/** §4.2 — этапы и их вклад в progress. */
export const PHASES = {
  queued: { status: 'queued', from: 0.0, to: 0.05 },
  preparing: { status: 'running', from: 0.05, to: 0.1 },
  downloading: { status: 'running', from: 0.1, to: 0.3 },
  rendering: { status: 'running', from: 0.3, to: 0.6 },
  encoding: { status: 'running', from: 0.6, to: 0.9 },
  uploading: { status: 'running', from: 0.9, to: 0.98 },
  finalizing: { status: 'running', from: 0.98, to: 1.0 },
  done: { status: 'succeeded', from: 1.0, to: 1.0 },
  failed: { status: 'failed', from: 0, to: 1 },
  cancelled: { status: 'cancelled', from: 0, to: 1 },
};

/** Разрешённые переходы статусов (§4.1). */
const TRANSITIONS = {
  queued: new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  running: new Set(['running', 'succeeded', 'failed', 'cancelled']),
  succeeded: new Set([]),
  failed: new Set([]),
  cancelled: new Set([]),
};

export function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]?.has(to));
}

/** Прогресс внутри этапа: fraction 0..1 отображается в диапазон этапа. */
export function progressFor(phase, fraction = 0) {
  const spec = PHASES[phase];
  if (!spec) return 0;
  const f = Math.min(1, Math.max(0, Number(fraction) || 0));
  return Number((spec.from + (spec.to - spec.from) * f).toFixed(4));
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

const EDIT_STYLES = new Set(['dynamicStyle', 'cinematic', 'calm', 'minimal']);
const CAPTION_STYLES = new Set(['clean', 'bold', 'karaoke']);
const MUSIC_TRACKS = new Set(['none', 'chill', 'energy', 'cinematic', 'trending']);
const TRANSITIONS_ALLOWED = new Set(['cut', 'fade', 'crossfade', 'slide']);
const MEDIA_TYPES = new Set(['video', 'photo']);

function bad(code, message, field) {
  throw new ApiError(code, message, { field });
}

function requireObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    bad('INVALID_REQUEST', `Поле «${field}» должно быть объектом.`, field);
  }
  return value;
}

// ── Идентификаторы ────────────────────────────────────────────────────────

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** ULID-подобный, монотонный по времени и безопасный для путей GCS. */
export function newId(prefix) {
  let ts = Date.now();
  let time = '';
  for (let i = 0; i < 10; i += 1) {
    time = B32[ts % 32] + time;
    ts = Math.floor(ts / 32);
  }
  const rand = Array.from(randomBytes(10), (b) => B32[b % 32]).join('');
  return `${prefix}_${time}${rand}`;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * JSON с рекурсивно отсортированными ключами и без «косметических» полей —
 * основа отпечатка идемпотентности (§5).
 */
const COSMETIC_CLIP_FIELDS = new Set(['filePath', 'sourceName', 'reason']);

export function canonicalJson(value, key = '') {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v, key)).join(',')}]`;
  }
  const parts = [];
  for (const k of Object.keys(value).sort()) {
    if (key === 'clips' && COSMETIC_CLIP_FIELDS.has(k)) continue;
    if (value[k] === undefined) continue;
    parts.push(`${JSON.stringify(k)}:${canonicalJson(value[k], k)}`);
  }
  return `{${parts.join(',')}}`;
}

// ── Экспорт: резолв разрешения ────────────────────────────────────────────

/** Максимальная сторона исходников — прокси «вертикальной» высоты 9:16. */
export function sourceMaxHeight(assets = []) {
  let max = 0;
  for (const a of assets) {
    const side = Math.max(Number(a.width) || 0, Number(a.height) || 0);
    if (side > max) max = side;
  }
  return max > 0 ? max : null;
}

/** Оценка размера (байты). Совпадает с ExportResolver в Flutter. */
export function estimateSizeBytes({ height, durationSeconds, fps = 30 }) {
  const baseBitrate = 10e6; // бит/с при height = 1920
  const factor = Math.pow(height / 1920, 1.5);
  const bits = baseBitrate * factor * (fps / 30) * durationSeconds;
  return Math.round(bits / 8);
}

/**
 * Резолв `maximumAvailable` в конкретное разрешение выполняет ТОЛЬКО backend
 * (§1). Возвращает готовый блок export для RenderJob.
 */
export function resolveExport({ choice, fps = 30, assets = [], durationSeconds = 0 }) {
  const requested = choice || AUTO_RESOLUTION;
  if (requested !== AUTO_RESOLUTION && !RESOLUTIONS[requested]) {
    bad('RESOLUTION_UNSUPPORTED', `Неизвестное разрешение «${requested}».`, 'export.resolution');
  }
  const safeFps = ALLOWED_FPS.includes(Number(fps)) ? Number(fps) : 30;
  const maxSide = sourceMaxHeight(assets);

  let concrete = requested;
  if (requested === AUTO_RESOLUTION) {
    concrete = 'fullHd1080';
    if (maxSide) {
      concrete = 'hd720';
      for (const key of CONCRETE_RESOLUTIONS) {
        if (RESOLUTIONS[key].height <= maxSide) concrete = key;
      }
    }
  }

  const spec = RESOLUTIONS[concrete];
  const isUpscale = requested === AUTO_RESOLUTION ? false : Boolean(maxSide && spec.height > maxSide);

  return {
    resolution: concrete,
    requestedResolution: requested,
    width: spec.width,
    height: spec.height,
    fps: safeFps,
    estimatedSizeBytes: estimateSizeBytes({ height: spec.height, durationSeconds, fps: safeFps }),
    isUpscale,
    videoBitrateKbps: spec.videoBitrateKbps,
    maxrateKbps: spec.maxrateKbps,
    audioBitrateKbps: spec.audioBitrateKbps,
    level: spec.level,
  };
}

// ── Пути Cloud Storage (§6) ───────────────────────────────────────────────

export function sourcesPrefix(projectId) {
  return `projects/${projectId}/sources/`;
}

export function jobPrefix(projectId, jobId) {
  return `projects/${projectId}/jobs/${jobId}/`;
}

export function planPath(projectId, jobId) {
  return `${jobPrefix(projectId, jobId)}plan.json`;
}

export function outputPrefix(projectId, jobId) {
  return `${jobPrefix(projectId, jobId)}output`;
}

export function outputVideoPath(projectId, jobId, height) {
  return `${outputPrefix(projectId, jobId)}/reel_${height}p.mp4`;
}

export function thumbnailPath(projectId, jobId) {
  return `${outputPrefix(projectId, jobId)}/thumbnail.jpg`;
}

/** Защита от path traversal и чужих префиксов (§6). */
export function assertObjectPath(objectPath, projectId, field) {
  if (typeof objectPath !== 'string' || objectPath.length === 0 || objectPath.length > 1024) {
    bad('INVALID_OBJECT_PATH', 'Путь объекта пуст или слишком длинный.', field);
  }
  if (objectPath.startsWith('gs://') || objectPath.startsWith('/')) {
    bad('INVALID_OBJECT_PATH', 'Путь объекта должен быть относительным (без gs:// и ведущего «/»).', field);
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(objectPath)) {
    bad('INVALID_OBJECT_PATH', 'Путь объекта содержит недопустимые символы.', field);
  }
  if (objectPath.includes('..') || objectPath.includes('//')) {
    bad('INVALID_OBJECT_PATH', 'Путь объекта содержит недопустимые сегменты.', field);
  }
  if (!objectPath.startsWith(`projects/${projectId}/`)) {
    bad('INVALID_OBJECT_PATH', 'Путь объекта вне каталога проекта.', field);
  }
  return objectPath;
}

// ── Валидация RenderRequest (§2, §3) ──────────────────────────────────────

function validateAssets(rawAssets, projectId) {
  if (!Array.isArray(rawAssets) || rawAssets.length === 0) {
    bad('INVALID_REQUEST', 'Нужен непустой список материалов «assets».', 'assets');
  }
  if (rawAssets.length > MAX_CLIPS) {
    bad('INVALID_REQUEST', `Слишком много материалов (максимум ${MAX_CLIPS}).`, 'assets');
  }
  const byId = new Map();
  const assets = rawAssets.map((raw, i) => {
    const field = `assets[${i}]`;
    requireObject(raw, field);
    const id = raw.id;
    if (typeof id !== 'string' || !ID_RE.test(id)) {
      bad('INVALID_REQUEST', 'Идентификатор материала должен быть [A-Za-z0-9_-]{1,64}.', `${field}.id`);
    }
    if (byId.has(id)) {
      bad('INVALID_REQUEST', `Дублирующийся идентификатор материала «${id}».`, `${field}.id`);
    }
    const type = raw.type;
    if (!MEDIA_TYPES.has(type)) {
      bad('INVALID_REQUEST', 'Тип материала должен быть video или photo.', `${field}.type`);
    }
    const objectPath = assertObjectPath(raw.objectPath, projectId, `${field}.objectPath`);
    const asset = {
      id,
      type,
      objectPath,
      sizeBytes: Number.isFinite(raw.sizeBytes) ? Math.round(raw.sizeBytes) : null,
      durationSeconds: Number.isFinite(raw.durationSeconds) ? Number(raw.durationSeconds) : null,
      width: Number.isFinite(raw.width) ? Math.round(raw.width) : null,
      height: Number.isFinite(raw.height) ? Math.round(raw.height) : null,
      checksumCrc32c: typeof raw.checksumCrc32c === 'string' ? raw.checksumCrc32c : null,
    };
    byId.set(id, asset);
    return asset;
  });
  return { assets, byId };
}

function validatePlan(rawPlan, assetsById) {
  requireObject(rawPlan, 'plan');

  if (typeof rawPlan.id !== 'string' || rawPlan.id.length === 0 || rawPlan.id.length > 128) {
    bad('PLAN_INVALID', 'План должен содержать строковый «id».', 'plan.id');
  }
  const style = rawPlan.style ?? 'dynamicStyle';
  if (!EDIT_STYLES.has(style)) {
    bad('PLAN_INVALID', `Неизвестный стиль монтажа «${style}».`, 'plan.style');
  }
  const durationSeconds = Math.round(Number(rawPlan.durationSeconds) || 0);
  if (durationSeconds < 1 || durationSeconds > MAX_DURATION_SECONDS) {
    bad('PLAN_INVALID', `«durationSeconds» должно быть 1..${MAX_DURATION_SECONDS}.`, 'plan.durationSeconds');
  }

  const rawCaptions = requireObject(rawPlan.captions ?? {}, 'plan.captions');
  const captionStyle = rawCaptions.style ?? 'clean';
  if (!CAPTION_STYLES.has(captionStyle)) {
    bad('PLAN_INVALID', `Неизвестный стиль субтитров «${captionStyle}».`, 'plan.captions.style');
  }
  const colorHex = rawCaptions.colorHex ?? '#FFFFFF';
  if (!HEX_COLOR_RE.test(colorHex)) {
    bad('PLAN_INVALID', 'Цвет субтитров должен быть в формате #RRGGBB.', 'plan.captions.colorHex');
  }
  const captions = {
    enabled: rawCaptions.enabled !== false,
    language: typeof rawCaptions.language === 'string' && rawCaptions.language ? rawCaptions.language : 'ru',
    style: captionStyle,
    colorHex: colorHex.toUpperCase(),
    sampleText: typeof rawCaptions.sampleText === 'string' ? rawCaptions.sampleText.slice(0, 200) : '',
  };

  const rawMusic = requireObject(rawPlan.music ?? {}, 'plan.music');
  const track = rawMusic.track ?? 'none';
  if (!MUSIC_TRACKS.has(track)) {
    bad('PLAN_INVALID', `Неизвестный трек «${track}».`, 'plan.music.track');
  }
  const volume = Number(rawMusic.volume ?? 0.7);
  if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
    bad('PLAN_INVALID', 'Громкость музыки должна быть в диапазоне 0..1.', 'plan.music.volume');
  }
  const music = { track, volume };

  const rawClips = rawPlan.clips;
  if (!Array.isArray(rawClips) || rawClips.length === 0) {
    bad('PLAN_INVALID', 'План должен содержать хотя бы один клип.', 'plan.clips');
  }
  if (rawClips.length > MAX_CLIPS) {
    bad('PLAN_INVALID', `Слишком много клипов (максимум ${MAX_CLIPS}).`, 'plan.clips');
  }

  const seenClipIds = new Set();
  let total = 0;
  const clips = rawClips.map((raw, i) => {
    const field = `plan.clips[${i}]`;
    requireObject(raw, field);

    const id = typeof raw.id === 'string' && raw.id ? raw.id : `clip_${i + 1}`;
    if (seenClipIds.has(id)) {
      bad('PLAN_INVALID', `Дублирующийся идентификатор клипа «${id}».`, `${field}.id`);
    }
    seenClipIds.add(id);

    const mediaId = raw.mediaId;
    if (typeof mediaId !== 'string' || !mediaId) {
      bad('PLAN_INVALID', 'Клип обязан ссылаться на материал через «mediaId».', `${field}.mediaId`);
    }
    const asset = assetsById.get(mediaId);
    if (!asset) {
      throw new ApiError('ASSET_MISSING', `Клип ссылается на неизвестный mediaId «${mediaId}».`, {
        field: `${field}.mediaId`,
      });
    }

    const type = MEDIA_TYPES.has(raw.type) ? raw.type : asset.type;
    const transition = raw.transition ?? 'cut';
    if (!TRANSITIONS_ALLOWED.has(transition)) {
      bad('PLAN_INVALID', `Недопустимый переход «${transition}».`, `${field}.transition`);
    }

    const duration = Number(raw.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      bad('PLAN_INVALID', 'Длительность клипа должна быть больше нуля.', `${field}.duration`);
    }

    let start = null;
    let end = null;
    if (type === 'video') {
      start = Number(raw.start ?? 0);
      end = Number(raw.end ?? start + duration);
      if (!Number.isFinite(start) || start < 0) {
        bad('PLAN_INVALID', 'Начало обрезки не может быть отрицательным.', `${field}.start`);
      }
      if (!Number.isFinite(end) || end - start < 0.1) {
        bad('PLAN_INVALID', 'Конец обрезки должен быть больше начала минимум на 0.1 с.', `${field}.end`);
      }
      if (asset.durationSeconds && end > asset.durationSeconds + 0.5) {
        bad('PLAN_INVALID', 'Обрезка выходит за пределы исходного материала.', `${field}.end`);
      }
    }

    total += duration;
    return {
      id,
      mediaId,
      type,
      duration,
      start,
      end,
      transition,
      sourceName: typeof raw.sourceName === 'string' ? raw.sourceName.slice(0, 200) : '',
      reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 300) : '',
    };
  });

  if (total > MAX_DURATION_SECONDS + 0.001) {
    throw new ApiError(
      'DURATION_EXCEEDED',
      `Суммарная длительность ${total.toFixed(1)} с превышает лимит ${MAX_DURATION_SECONDS} с.`,
      { field: 'plan.clips' },
    );
  }

  const coverClipId = typeof rawPlan.coverClipId === 'string' ? rawPlan.coverClipId : null;
  if (coverClipId && !seenClipIds.has(coverClipId)) {
    bad('PLAN_INVALID', 'Обложка ссылается на несуществующий клип.', 'plan.coverClipId');
  }

  return {
    plan: {
      id: rawPlan.id,
      prompt: typeof rawPlan.prompt === 'string' ? rawPlan.prompt.slice(0, 2000) : '',
      style,
      durationSeconds,
      captions,
      music,
      coverClipId,
      clips,
    },
    totalDuration: total,
  };
}

/**
 * Полная валидация и нормализация RenderRequest.
 * Возвращает данные, готовые к записи в Firestore и в plan.json.
 */
export function validateRenderRequest(body) {
  requireObject(body, 'body');

  const version = body.contractVersion ?? CONTRACT_VERSION;
  if (Number(version) !== CONTRACT_VERSION) {
    throw new ApiError(
      'CONTRACT_VERSION_UNSUPPORTED',
      `Поддерживается только версия контракта ${CONTRACT_VERSION}.`,
      { field: 'contractVersion' },
    );
  }

  const projectId = body.projectId;
  if (typeof projectId !== 'string' || !ID_RE.test(projectId)) {
    bad('INVALID_REQUEST', 'Идентификатор проекта должен быть [A-Za-z0-9_-]{1,64}.', 'projectId');
  }

  const { assets, byId } = validateAssets(body.assets, projectId);
  const { plan, totalDuration } = validatePlan(body.plan, byId);

  // export из запроса перекрывает plan.export (§3).
  const rawExport = body.export ?? body.plan?.export ?? {};
  requireObject(rawExport, 'export');
  const exportSettings = resolveExport({
    choice: rawExport.resolution ?? AUTO_RESOLUTION,
    fps: rawExport.fps ?? 30,
    assets,
    durationSeconds: Math.max(1, Math.round(totalDuration)),
  });

  return { projectId, plan, assets, export: exportSettings, totalDuration };
}

/** Отпечаток идемпотентности (§5). */
export function buildFingerprint({ projectId, plan, assets, export: exp, idempotencyKey }) {
  const content = canonicalJson({
    projectId,
    plan,
    assets,
    export: { resolution: exp.requestedResolution, fps: exp.fps },
  });
  const contentHash = sha256(content);
  const key = idempotencyKey || contentHash;
  return { fingerprint: sha256(`${projectId}:${key}`), contentHash };
}
