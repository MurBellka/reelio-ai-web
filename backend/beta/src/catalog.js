// Перечисления контракта v2 на стороне beta backend'а.
//
// Копия, а не импорт из worker-v2: это отдельные деплои со своими образами, и
// связывать их файловой зависимостью значило бы собирать один образ из двух
// каталогов. Дрейф ловит test/unit/catalog-sync.test.js — он парсит
// docs/render-contract-v2.md и сверяет таблицы.
//
// Здесь же собран CATALOG для промта: модель выбирает значения только отсюда
// (§15), поэтому список должен быть исчерпывающим и совпадать с тем, что умеет
// worker.

import { PROJECT_LIMITS } from './limits.js';

/** §2.1 — канонические типы переходов (синонимы v1 в промт не идут). */
export const TRANSITION_TYPES = [
  'cut',
  'dissolve',
  'fadeBlack',
  'fadeWhite',
  'wipeLeft',
  'wipeRight',
  'wipeUp',
  'wipeDown',
  'slideLeft',
  'slideRight',
  'slideUp',
  'slideDown',
  'smoothLeft',
  'smoothRight',
  'smoothUp',
  'smoothDown',
  'circleOpen',
  'circleClose',
  'zoomIn',
  'pixelize',
  'radial',
  'blur',
];

/** Синонимы v1, которые всё ещё принимаются на входе (§7 контракта). */
export const TRANSITION_ALIASES = {
  crossfade: 'dissolve',
  fade: 'fadeBlack',
  slide: 'slideLeft',
  zoom: 'zoomIn',
};

export const TRANSITION_INTENSITIES = ['calm', 'balanced', 'dynamic'];
export const MIN_TRANSITION_SECONDS = 0.15;
export const MAX_TRANSITION_SECONDS = 1.5;

/** §5 — идентификаторы шрифтов каталога. */
export const FONT_IDS = [
  'inter',
  'montserrat',
  'manrope',
  'roboto',
  'pt_sans',
  'oswald',
  'unbounded',
  'caveat',
  'pacifico',
];
export const DEFAULT_FONT_ID = 'inter';
export const FONT_WEIGHTS = ['regular', 'medium', 'bold'];

/** §4 — текстовые слои. */
export const TEXT_ANIMATIONS = ['none', 'fade', 'slide', 'pop'];
export const TEXT_ANCHORS = ['top', 'center', 'bottom'];
export const TEXT_ALIGNS = ['left', 'center', 'right'];
export const MIN_FONT_SIZE_RATIO = 0.02;
export const MAX_FONT_SIZE_RATIO = 0.15;
export const MAX_TEXT_OVERLAYS = 20;
export const MAX_TEXT_LENGTH = 200;

/** §4.2 — безопасная зона Instagram Reels. */
export const SAFE_ZONE = { top: 0.14, bottom: 0.2, left: 0.06, right: 0.06 };
export const ANCHOR_Y = { top: 0.18, center: 0.5, bottom: 0.8 };

/** §6 — стили субтитров. */
export const CAPTION_STYLES = ['clean', 'bold', 'karaoke', 'minimal'];
export const CAPTION_POSITIONS = ['top', 'center', 'bottom'];

/** §8 — пресеты экспорта и разрешения. */
export const EXPORT_PRESETS = ['instagramReels'];
export const RESOLUTIONS = ['hd720', 'fullHd1080', 'twoK1440', 'fourK2160'];
export const ALLOWED_FPS = [30, 60];

export const MAX_CLIPS = 60;

/**
 * Каталог для промта. `verifiedTransitions` приходит от worker'а (§2.2): если
 * сборка FFmpeg чего-то не умеет, модель не должна это предлагать.
 */
export function buildPromptCatalog({ verifiedTransitions } = {}) {
  const transitions =
    Array.isArray(verifiedTransitions) && verifiedTransitions.length > 0
      ? TRANSITION_TYPES.filter((t) => verifiedTransitions.includes(t))
      : TRANSITION_TYPES;

  return {
    transitions,
    intensities: TRANSITION_INTENSITIES,
    fonts: FONT_IDS,
    animations: TEXT_ANIMATIONS,
    anchors: TEXT_ANCHORS,
    captionStyles: CAPTION_STYLES,
    constraints: {
      maxOutputDurationSeconds: PROJECT_LIMITS.maxOutputDurationSeconds,
      maxClips: MAX_CLIPS,
      maxTextOverlays: MAX_TEXT_OVERLAYS,
      maxTextLength: MAX_TEXT_LENGTH,
      minTransitionSeconds: MIN_TRANSITION_SECONDS,
      maxTransitionSeconds: MAX_TRANSITION_SECONDS,
      safeZone: SAFE_ZONE,
      audioOptions: ['keepOriginal', 'silent'],
    },
  };
}

/** Приводит синоним v1 к каноническому типу; неизвестное — null. */
export function canonicalTransitionType(type) {
  if (TRANSITION_TYPES.includes(type)) return type;
  return TRANSITION_ALIASES[type] ?? null;
}
