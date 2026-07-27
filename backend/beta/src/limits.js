// Лимиты анализа и монтажа (§10, §11 задания; §9 контракта v2).
//
// Все пределы собраны в одном месте по двум причинам. Во-первых, анализ тратит
// платные вызовы Gemini, и «сколько это может стоить» должно читаться в одном
// файле, а не восстанавливаться по коду. Во-вторых, лимиты — часть контракта с
// клиентом: UI обязан показывать те же числа, что применяет сервер.

/** §10 — сколько материала принимаем в один проект. */
export const PROJECT_LIMITS = {
  maxVideos: 20,
  maxPhotos: 20,
  /** Одно видео — не длиннее 10 минут. */
  maxVideoDurationSeconds: 600,
  /** Готовый ролик — потолок продукта, тот же что в v1. */
  maxOutputDurationSeconds: 120,
};

/** §11 — что ограничивает стоимость и время одного анализа. */
export const ANALYSIS_LIMITS = {
  /** Кадров на одно видео, отправляемых в Gemini vision. */
  maxFramesPerVideo: 12,
  /** Кадров на весь проект: 20 видео × 12 дало бы 240 — слишком дорого. */
  maxFramesPerProject: 80,
  /** Секунд аудио на одно видео, отправляемых в Gemini audio. */
  maxAudioSecondsPerVideo: 120,
  /** Секунд аудио на весь проект. */
  maxAudioSecondsPerProject: 600,
  /** Размер одного кадра JPEG, байт: больше — только зря платим за токены. */
  maxFrameBytes: 400 * 1024,
  /** Размер аудиофрагмента, байт. */
  maxAudioBytes: 12 * 1024 * 1024,
  /** Потолок времени на анализ одного материала. */
  perAssetTimeoutMs: 120_000,
  /** Потолок времени на анализ всего проекта. */
  projectTimeoutMs: 900_000,
  /** Таймаут одного вызова Gemini. */
  geminiTimeoutMs: 60_000,
  /** Повторов вызова Gemini при ретраебельной ошибке. */
  maxGeminiRetries: 2,
  /** Максимум вызовов Gemini на проект — жёсткий предохранитель от цикла. */
  maxGeminiCallsPerProject: 60,
};

/** §11 — денежный потолок. Считается по прайсу модели, см. estimateCostUsd. */
export const COST_LIMITS = {
  /** Потолок стоимости анализа одного проекта, USD. */
  maxProjectUsd: 0.5,
  /** Суточный потолок на пользователя, USD. */
  maxUserDailyUsd: 2.0,
};

/**
 * Прайс Gemini 2.5 Flash, USD за миллион токенов. Числа вынесены в константы,
 * чтобы смена модели не превращалась в раскопки по коду.
 */
export const PRICING = {
  model: 'gemini-2.5-flash',
  inputPerMillionTokens: 0.3,
  outputPerMillionTokens: 2.5,
  /** Токенов на один кадр 768×768 — по документации модели. */
  tokensPerImage: 258,
  /** Токенов на секунду аудио. */
  tokensPerAudioSecond: 32,
};

/** §9 контракта v2 — сколько анализов в сутки разрешено. */
export const ANALYSIS_QUOTA = {
  perUserPerDay: 20,
  perProjectPerDay: 8,
};

/**
 * Оценка стоимости в USD по объёму отправленного.
 *
 * Считается ДО вызова (чтобы не начинать заведомо дорогой анализ) и после
 * (чтобы вести фактический учёт).
 *
 * @param {{frames?: number, audioSeconds?: number, promptTokens?: number,
 *          outputTokens?: number}} usage
 */
export function estimateCostUsd(usage = {}) {
  const frames = Math.max(0, usage.frames ?? 0);
  const audioSeconds = Math.max(0, usage.audioSeconds ?? 0);
  const promptTokens = Math.max(0, usage.promptTokens ?? 0);
  const outputTokens = Math.max(0, usage.outputTokens ?? 0);

  const inputTokens =
    frames * PRICING.tokensPerImage + audioSeconds * PRICING.tokensPerAudioSecond + promptTokens;

  const usd =
    (inputTokens / 1_000_000) * PRICING.inputPerMillionTokens +
    (outputTokens / 1_000_000) * PRICING.outputPerMillionTokens;

  // Округляем вверх до сотой цента: недооценка опаснее переоценки.
  return Math.ceil(usd * 100_000) / 100_000;
}

/**
 * Сколько кадров брать с видео: пропорционально длительности, но в пределах
 * лимита и не чаще одного кадра на 2 секунды — чаще бессмысленно для монтажа.
 */
export function framesForDuration(durationSeconds, limit = ANALYSIS_LIMITS.maxFramesPerVideo) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 1;
  const byDensity = Math.ceil(durationSeconds / 2);
  return Math.max(1, Math.min(limit, byDensity));
}

/** Ошибка превышения лимита — отдельный тип, чтобы API вернул понятный код. */
export class LimitExceededError extends Error {
  /** @param {string} limit имя нарушенного лимита @param {string} message текст для пользователя */
  constructor(limit, message, details = {}) {
    super(message);
    this.name = 'LimitExceededError';
    this.code = 'LIMIT_EXCEEDED';
    this.limit = limit;
    this.details = details;
    this.retryable = false;
  }
}

/**
 * Проверка состава проекта до начала анализа (§10).
 *
 * @param {{videos: number, photos: number, longestVideoSeconds: number}} project
 */
export function assertProjectWithinLimits(project) {
  const { videos = 0, photos = 0, longestVideoSeconds = 0 } = project;

  if (videos > PROJECT_LIMITS.maxVideos) {
    throw new LimitExceededError(
      'maxVideos',
      `Слишком много видео: ${videos}. Максимум ${PROJECT_LIMITS.maxVideos}.`,
      { actual: videos, allowed: PROJECT_LIMITS.maxVideos },
    );
  }
  if (photos > PROJECT_LIMITS.maxPhotos) {
    throw new LimitExceededError(
      'maxPhotos',
      `Слишком много фотографий: ${photos}. Максимум ${PROJECT_LIMITS.maxPhotos}.`,
      { actual: photos, allowed: PROJECT_LIMITS.maxPhotos },
    );
  }
  if (longestVideoSeconds > PROJECT_LIMITS.maxVideoDurationSeconds) {
    throw new LimitExceededError(
      'maxVideoDurationSeconds',
      `Видео длиннее ${PROJECT_LIMITS.maxVideoDurationSeconds / 60} минут не поддерживается.`,
      { actual: longestVideoSeconds, allowed: PROJECT_LIMITS.maxVideoDurationSeconds },
    );
  }
}

/**
 * Учёт расхода на проект. Держит счётчики кадров, аудио, вызовов и денег и
 * не даёт превысить ни один из них.
 */
export class CostBudget {
  constructor(limits = {}) {
    this.maxUsd = limits.maxUsd ?? COST_LIMITS.maxProjectUsd;
    this.maxFrames = limits.maxFrames ?? ANALYSIS_LIMITS.maxFramesPerProject;
    this.maxAudioSeconds = limits.maxAudioSeconds ?? ANALYSIS_LIMITS.maxAudioSecondsPerProject;
    this.maxCalls = limits.maxCalls ?? ANALYSIS_LIMITS.maxGeminiCallsPerProject;

    this.frames = 0;
    this.audioSeconds = 0;
    this.calls = 0;
    this.usd = 0;
  }

  /** Хватит ли бюджета на планируемый вызов. Ничего не списывает. */
  canAfford({ frames = 0, audioSeconds = 0 }) {
    const usd = estimateCostUsd({ frames, audioSeconds });
    return (
      this.frames + frames <= this.maxFrames &&
      this.audioSeconds + audioSeconds <= this.maxAudioSeconds &&
      this.calls + 1 <= this.maxCalls &&
      this.usd + usd <= this.maxUsd
    );
  }

  /** Списывает расход или бросает LimitExceededError. */
  charge({ frames = 0, audioSeconds = 0, promptTokens = 0, outputTokens = 0 }) {
    if (this.calls + 1 > this.maxCalls) {
      throw new LimitExceededError('maxGeminiCallsPerProject', 'Превышен лимит обращений к ИИ.', {
        actual: this.calls + 1,
        allowed: this.maxCalls,
      });
    }
    if (this.frames + frames > this.maxFrames) {
      throw new LimitExceededError('maxFramesPerProject', 'Превышен лимит кадров для анализа.', {
        actual: this.frames + frames,
        allowed: this.maxFrames,
      });
    }
    if (this.audioSeconds + audioSeconds > this.maxAudioSeconds) {
      throw new LimitExceededError('maxAudioSecondsPerProject', 'Превышен лимит аудио для анализа.', {
        actual: this.audioSeconds + audioSeconds,
        allowed: this.maxAudioSeconds,
      });
    }

    const usd = estimateCostUsd({ frames, audioSeconds, promptTokens, outputTokens });
    if (this.usd + usd > this.maxUsd) {
      throw new LimitExceededError('maxProjectUsd', 'Превышен бюджет анализа проекта.', {
        actual: Number((this.usd + usd).toFixed(5)),
        allowed: this.maxUsd,
      });
    }

    this.calls += 1;
    this.frames += frames;
    this.audioSeconds += audioSeconds;
    this.usd = Number((this.usd + usd).toFixed(5));
    return { usd, totalUsd: this.usd };
  }

  /** Снимок для отчёта и логов. Денег не раскрывает клиенту — только серверу. */
  snapshot() {
    return {
      calls: this.calls,
      frames: this.frames,
      audioSeconds: this.audioSeconds,
      usd: this.usd,
      maxUsd: this.maxUsd,
    };
  }
}
