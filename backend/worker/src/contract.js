// Сторона worker'а для docs/render-contract.md v1.
//
// Worker — отдельный деплой (Cloud Run Job) со своим образом, поэтому таблицы
// контракта продублированы здесь, а не импортируются из backend/src. Дрейф
// ловит test/contract-sync.test.js: он парсит §1 и §4.2 самого документа и
// сверяет их с этими константами.

export const CONTRACT_VERSION = 1;

export const MAX_DURATION_SECONDS = 120;
export const MAX_CLIPS = 60;

/** §1 — разрешения экспорта 9:16. */
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

/** §4.2 — этапы и их вклад в глобальный progress. */
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

/** Глобальный progress по этапу и доле внутри него (зеркало backend'а). */
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

/** §2 — переходы контракта плюс расширения UI (правило совместимости §0). */
export const CONTRACT_TRANSITIONS = ['cut', 'fade', 'crossfade', 'slide'];
export const EXTRA_TRANSITIONS = ['dissolve', 'zoom'];
export const ALLOWED_TRANSITIONS = new Set([...CONTRACT_TRANSITIONS, ...EXTRA_TRANSITIONS]);

/**
 * Переход контракта → transition-режим фильтра xfade.
 * `crossfade` и `dissolve` — синонимы: плавное растворение (xfade `fade`).
 * Контрактный `fade` — затемнение через чёрный (xfade `fadeblack`).
 */
export const XFADE_BY_TRANSITION = {
  fade: 'fadeblack',
  crossfade: 'fade',
  dissolve: 'fade',
  slide: 'slideleft',
  zoom: 'zoomin',
};

export const CAPTION_STYLES = new Set(['clean', 'bold', 'karaoke']);
export const MUSIC_TRACKS = new Set(['none', 'chill', 'energy', 'cinematic', 'trending']);
export const MEDIA_TYPES = new Set(['video', 'photo']);
export const EDIT_STYLES = new Set(['dynamicStyle', 'cinematic', 'calm', 'minimal']);

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

/** §6 — пути внутри бакета. */
export function outputVideoPath(outputPrefix, height) {
  return `${outputPrefix}/reel_${height}p.mp4`;
}

export function thumbnailPath(outputPrefix) {
  return `${outputPrefix}/thumbnail.jpg`;
}

export function logPath(projectId, jobId) {
  return `projects/${projectId}/jobs/${jobId}/logs/worker.log`;
}

export function tmpPrefix(projectId, jobId) {
  return `projects/${projectId}/jobs/${jobId}/tmp/`;
}

/**
 * §6 — путь обязан лежать внутри projects/{projectId}/ и не содержать
 * traversal-сегментов. Возвращает путь либо бросает исключение через `onBad`.
 */
export function checkObjectPath(objectPath, projectId) {
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
  if (!objectPath.startsWith(`projects/${projectId}/`)) {
    return 'Путь объекта вне каталога проекта.';
  }
  return null;
}
