// Сторона worker'а v2 для docs/render-contract-v2.md.
//
// v2 — надстройка над v1: разрешения, фазы и пути наследуются без изменений,
// добавляются каталог переходов, текстовые слои, шрифты и переключатель звука.
// Дрейф ловит test/unit/contract-sync.test.js: он парсит оба документа и
// сверяет их с этими таблицами.

export const CONTRACT_VERSION = 2;
/** Версии планов, которые worker v2 умеет принимать (§0). */
export const SUPPORTED_PLAN_VERSIONS = [1, 2];

export const MAX_DURATION_SECONDS = 120;
export const MAX_CLIPS = 60;
export const MAX_TEXT_OVERLAYS = 20;
export const MAX_TEXT_LENGTH = 200;

/** §1 v1 — разрешения экспорта 9:16. В v2 не менялись. */
export const RESOLUTIONS = {
  hd720: {
    label: '720p',
    width: 720,
    height: 1280,
    videoBitrateKbps: 4000,
    maxrateKbps: 5000,
    audioBitrateKbps: 128,
    level: '4.0',
  },
  fullHd1080: {
    label: '1080p',
    width: 1080,
    height: 1920,
    videoBitrateKbps: 8000,
    maxrateKbps: 10000,
    audioBitrateKbps: 160,
    level: '4.2',
  },
  twoK1440: {
    label: '2K',
    width: 1440,
    height: 2560,
    videoBitrateKbps: 16000,
    maxrateKbps: 20000,
    audioBitrateKbps: 192,
    level: '5.0',
  },
  fourK2160: {
    label: '4K',
    width: 2160,
    height: 3840,
    videoBitrateKbps: 35000,
    maxrateKbps: 45000,
    audioBitrateKbps: 192,
    level: '5.1',
  },
};

export const AUTO_RESOLUTION = 'maximumAvailable';
export const ALLOWED_FPS = [30, 60];

/** §8 v2 — пресеты экспорта. Пресет перекрывает resolution и fps. */
export const EXPORT_PRESETS = {
  instagramReels: { resolution: 'fullHd1080', fps: 30, label: 'Instagram Reels' },
};

/** §4.2 v1 — этапы и их вклад в глобальный progress. */
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

export function progressFor(phase, fraction = 0) {
  const spec = PHASES[phase];
  if (!spec) return 0;
  const f = Math.min(1, Math.max(0, Number(fraction) || 0));
  return Number((spec.from + (spec.to - spec.from) * f).toFixed(4));
}

/** Уровень H.264 из таблицы §1 в форму, понятную libx264 (`4.2` → `42`). */
export function levelToX264(level) {
  return String(level).replace('.', '');
}

// ── §4.2 v2 — безопасная зона Instagram Reels ─────────────────────────────

/**
 * Доли кадра, которые перекрывает интерфейс Reels. Важный текст сюда не
 * ставится: сверху — таймлайн и аватар, снизу — подпись, звук и кнопки.
 */
export const SAFE_ZONE = { top: 0.14, bottom: 0.2, left: 0.06, right: 0.06 };

/** Значение `y` по умолчанию для каждого якоря (§4.2). */
export const ANCHOR_Y = { top: 0.18, center: 0.5, bottom: 0.8 };

export const TEXT_ANCHORS = new Set(['top', 'center', 'bottom']);
export const TEXT_ALIGNS = new Set(['left', 'center', 'right']);
export const TEXT_ANIMATIONS = new Set(['none', 'fade', 'slide', 'pop']);
export const FONT_WEIGHTS = new Set(['regular', 'medium', 'bold']);

/** §4 v2 — пределы кегля в долях высоты кадра. */
export const MIN_FONT_SIZE_RATIO = 0.02;
export const MAX_FONT_SIZE_RATIO = 0.15;

/** Лежит ли точка внутри безопасной зоны (§4.2). */
export function isInsideSafeZone(x, y) {
  return (
    x >= SAFE_ZONE.left &&
    x <= 1 - SAFE_ZONE.right &&
    y >= SAFE_ZONE.top &&
    y <= 1 - SAFE_ZONE.bottom
  );
}

/** Двигает точку внутрь безопасной зоны, сохраняя её как можно ближе к исходной. */
export function clampToSafeZone(x, y) {
  return {
    x: Math.min(Math.max(x, SAFE_ZONE.left), 1 - SAFE_ZONE.right),
    y: Math.min(Math.max(y, SAFE_ZONE.top), 1 - SAFE_ZONE.bottom),
  };
}

// ── §6 v2 — субтитры ──────────────────────────────────────────────────────

export const CAPTION_STYLES = new Set(['clean', 'bold', 'karaoke', 'minimal']);
export const CAPTION_POSITIONS = new Set(['top', 'center', 'bottom']);

// ── §1 v2 — звук ──────────────────────────────────────────────────────────

/** Цель нормализации мастера, LUFS. */
export const LOUDNESS_TARGET_LUFS = -16;
export const LOUDNESS_TRUE_PEAK_DB = -1.5;
/** Микрофейд на стыке `cut`, мс: убирает щелчок от разрыва волны. */
export const JOIN_FADE_MS = 15;

// ── Прочее ────────────────────────────────────────────────────────────────

export const MEDIA_TYPES = new Set(['video', 'photo']);
export const EDIT_STYLES = new Set(['dynamicStyle', 'cinematic', 'calm', 'minimal']);

/** §0 — поля v1, которые принимаются и игнорируются. */
export const DEPRECATED_V1_FIELDS = ['music'];

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

/** §6 v1 — пути внутри бакета. */
export function outputVideoPath(outputPrefix, height) {
  return `${outputPrefix}/reel_${height}p.mp4`;
}

export function thumbnailPath(outputPrefix) {
  return `${outputPrefix}/thumbnail.jpg`;
}

export function logPath(jobPrefix) {
  return `${jobPrefix}logs/worker.log`;
}

export function tmpPrefix(jobPrefix) {
  return `${jobPrefix}tmp/`;
}

/** §2.4 v2 — где лежит превью перехода. */
export function transitionPreviewPath(type) {
  return `previews/transitions/${type}.mp4`;
}

/**
 * §6 v1 — путь обязан лежать внутри выданного backend'ом префикса проекта и не
 * содержать traversal-сегментов. Схему путей знает только backend, он же
 * встраивает в неё проверенный uid владельца.
 */
export function checkObjectPath(objectPath, projectPrefix) {
  if (typeof objectPath !== 'string' || objectPath.length === 0 || objectPath.length > 1024) {
    return 'Путь объекта пуст или слишком длинный.';
  }
  if (objectPath.startsWith('gs://') || objectPath.startsWith('/')) {
    return 'Путь объекта должен быть относительным (без gs:// и ведущего «/»).';
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(objectPath)) {
    return 'Путь объекта содержит недопустимые символы.';
  }
  if (objectPath.includes('..') || objectPath.includes('//')) {
    return 'Путь объекта содержит недопустимые сегменты.';
  }
  if (!projectPrefix || !objectPath.startsWith(projectPrefix)) {
    return 'Путь объекта вне каталога проекта.';
  }
  return null;
}
