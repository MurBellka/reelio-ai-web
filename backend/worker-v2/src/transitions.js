// Каталог переходов (§2 контракта v2).
//
// Принцип: никаких сторонних transition pack'ов с неясной лицензией — только
// то, что умеет сама сборка FFmpeg. Поэтому таблица ниже описывает намерение,
// а реально доступный набор worker выясняет у бинаря (`ffmpeg -h filter=xfade`)
// и строит из пересечения «проверенный каталог». UI показывает пользователю
// именно его, так что переход, который не отрендерится, выбрать нельзя.

/** §2.1 — тип перехода → режим фильтра xfade. `cut` фильтра не требует. */
export const TRANSITION_CATALOG = {
  cut: { xfade: null, group: 'basic', label: 'Склейка' },
  dissolve: { xfade: 'fade', group: 'basic', label: 'Растворение' },
  // Форма v1: то же растворение под старым именем.
  crossfade: { xfade: 'fade', group: 'basic', label: 'Растворение', aliasOf: 'dissolve' },

  fadeBlack: { xfade: 'fadeblack', group: 'fade', label: 'Через чёрный' },
  fadeWhite: { xfade: 'fadewhite', group: 'fade', label: 'Через белый' },

  wipeLeft: { xfade: 'wipeleft', group: 'wipe', label: 'Шторка влево' },
  wipeRight: { xfade: 'wiperight', group: 'wipe', label: 'Шторка вправо' },
  wipeUp: { xfade: 'wipeup', group: 'wipe', label: 'Шторка вверх' },
  wipeDown: { xfade: 'wipedown', group: 'wipe', label: 'Шторка вниз' },

  slideLeft: { xfade: 'slideleft', group: 'slide', label: 'Сдвиг влево' },
  slideRight: { xfade: 'slideright', group: 'slide', label: 'Сдвиг вправо' },
  slideUp: { xfade: 'slideup', group: 'slide', label: 'Сдвиг вверх' },
  slideDown: { xfade: 'slidedown', group: 'slide', label: 'Сдвиг вниз' },

  smoothLeft: { xfade: 'smoothleft', group: 'smooth', label: 'Плавно влево' },
  smoothRight: { xfade: 'smoothright', group: 'smooth', label: 'Плавно вправо' },
  smoothUp: { xfade: 'smoothup', group: 'smooth', label: 'Плавно вверх' },
  smoothDown: { xfade: 'smoothdown', group: 'smooth', label: 'Плавно вниз' },

  circleOpen: { xfade: 'circleopen', group: 'circle', label: 'Круг раскрывается' },
  circleClose: { xfade: 'circleclose', group: 'circle', label: 'Круг закрывается' },

  zoomIn: { xfade: 'zoomin', group: 'zoom', label: 'Наплыв' },

  pixelize: { xfade: 'pixelize', group: 'effect', label: 'Пиксели' },
  radial: { xfade: 'radial', group: 'effect', label: 'Радиальный' },
  blur: { xfade: 'hblur', group: 'effect', label: 'Размытие' },
};

/** Тип, на который откатываемся, если запрошенный недоступен. */
export const FALLBACK_TRANSITION = 'dissolve';

/** §2.3 — интенсивность задаёт длительность, если она не указана явно. */
export const INTENSITY_DURATIONS = { calm: 0.8, balanced: 0.45, dynamic: 0.25 };
export const INTENSITIES = Object.keys(INTENSITY_DURATIONS);
export const DEFAULT_INTENSITY = 'balanced';

/** §2.3 — жёсткие пределы длительности перехода, с. */
export const MIN_TRANSITION_SECONDS = 0.15;
export const MAX_TRANSITION_SECONDS = 1.5;
/** Перекрытие не длиннее этой доли более короткого из соседних клипов. */
export const MAX_OVERLAP_RATIO = 0.4;

/** Синонимы v1 → канонические типы v2 (§7). */
export const V1_TRANSITION_MIGRATION = {
  cut: 'cut',
  fade: 'fadeBlack',
  crossfade: 'crossfade',
  slide: 'slideLeft',
  // Расширения, которые успели появиться в v1-планах клиента.
  dissolve: 'dissolve',
  zoom: 'zoomIn',
};

export function isKnownTransition(type) {
  return Object.hasOwn(TRANSITION_CATALOG, type);
}

/** Канонический тип: снимает синонимы вроде `crossfade` → `dissolve`. */
export function canonicalTransition(type) {
  const entry = TRANSITION_CATALOG[type];
  if (!entry) return FALLBACK_TRANSITION;
  return entry.aliasOf ?? type;
}

/**
 * Проверенный каталог: пересечение §2.1 с тем, что реально умеет эта сборка
 * FFmpeg. `cut` доступен всегда — он не использует фильтров.
 *
 * @param {Set<string>} availableXfadeModes из detectCapabilities()
 * @returns {{types: string[], byType: Record<string, object>, missing: string[]}}
 */
export function buildVerifiedCatalog(availableXfadeModes) {
  const known = availableXfadeModes instanceof Set ? availableXfadeModes : new Set();
  const types = [];
  const missing = [];
  const byType = {};

  for (const [type, entry] of Object.entries(TRANSITION_CATALOG)) {
    // Синонимы в каталоге для UI не дублируем — показываем канонические типы.
    if (entry.aliasOf) continue;

    // Если сборка не отдала список режимов, доверяем таблице: лучше показать
    // каталог целиком, чем схлопнуть его до одной склейки.
    const supported = entry.xfade === null || known.size === 0 || known.has(entry.xfade);
    if (supported) {
      types.push(type);
      byType[type] = { ...entry, type };
    } else {
      missing.push(type);
    }
  }

  return { types, byType, missing };
}

/**
 * Длительность перехода из плана и ограничений соседних клипов (§2.3).
 *
 * @returns {{seconds: number, clampedBy: string|null}} 0 секунд означает, что
 *   переход выродился в стык.
 */
export function resolveTransitionDuration({
  requestedSeconds = null,
  intensity = DEFAULT_INTENSITY,
  prevDuration,
  nextDuration,
}) {
  const base =
    Number.isFinite(requestedSeconds) && requestedSeconds > 0
      ? Number(requestedSeconds)
      : INTENSITY_DURATIONS[intensity] ?? INTENSITY_DURATIONS[DEFAULT_INTENSITY];

  let clampedBy = null;
  let seconds = base;

  if (seconds > MAX_TRANSITION_SECONDS) {
    seconds = MAX_TRANSITION_SECONDS;
    clampedBy = 'max';
  }
  if (seconds < MIN_TRANSITION_SECONDS) {
    seconds = MIN_TRANSITION_SECONDS;
    clampedBy = 'min';
  }

  // Переход не должен «съесть» соседний клип целиком.
  const neighbourLimit = MAX_OVERLAP_RATIO * Math.min(prevDuration, nextDuration);
  if (seconds > neighbourLimit) {
    seconds = neighbourLimit;
    clampedBy = 'neighbour';
  }

  // Слишком короткий переход незаметен и ломает xfade — честнее сделать стык.
  if (seconds < MIN_TRANSITION_SECONDS) {
    return { seconds: 0, clampedBy: 'degraded-to-cut' };
  }

  return { seconds: Number(seconds.toFixed(3)), clampedBy };
}

/**
 * Разбирает поле `transition` плана: объект v2 либо строка v1 (§2, §7).
 *
 * @returns {{type: string, durationSeconds: number|null, intensity: string}}
 */
export function normalizeTransition(raw) {
  if (raw == null) {
    return { type: 'cut', durationSeconds: null, intensity: DEFAULT_INTENSITY };
  }

  if (typeof raw === 'string') {
    const migrated = V1_TRANSITION_MIGRATION[raw] ?? (isKnownTransition(raw) ? raw : null);
    return migrated
      ? { type: migrated, durationSeconds: null, intensity: DEFAULT_INTENSITY }
      : null;
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) return null;

  const type = V1_TRANSITION_MIGRATION[raw.type] ?? raw.type;
  if (!isKnownTransition(type)) return null;

  const intensity = INTENSITIES.includes(raw.intensity) ? raw.intensity : DEFAULT_INTENSITY;

  let durationSeconds = null;
  if (raw.durationSeconds !== undefined && raw.durationSeconds !== null) {
    const value = Number(raw.durationSeconds);
    if (!Number.isFinite(value) || value < MIN_TRANSITION_SECONDS || value > MAX_TRANSITION_SECONDS) {
      return null;
    }
    durationSeconds = value;
  }

  return { type, durationSeconds, intensity };
}
