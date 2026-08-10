// Схема MediaAnalysis и её строгая валидация (§7 задания).
//
// Правило: некорректный ответ Gemini не должен попадать в EditPlan. Поэтому
// между моделью и планом стоит этот модуль — он принимает сырой объект и
// возвращает либо полностью нормализованный MediaAnalysis, либо ошибку.
// «Частично корректный» результат не пропускается: лучше повторить вызов.
//
// Важное про §5: лица и люди определяются ТОЛЬКО ради кадрирования. В схеме
// нет ни имён, ни идентификаторов личности, ни дескрипторов — только
// прямоугольник в долях кадра и уверенность. Биометрический профиль по этим
// данным построить нельзя, и хранить их дольше проекта незачем.

import {
  UnsafeModelOutputError,
  clampNumber,
  pickEnum,
  safeText,
} from './sanitize.js';

export const ANALYSIS_VERSION = 1;

export const SHOT_TYPES = new Set(['wide', 'medium', 'closeup', 'unknown']);
export const MOTION_LEVELS = new Set(['static', 'slow', 'moderate', 'fast']);
export const SUBJECT_KINDS = new Set(['person', 'face', 'object', 'scenery', 'text', 'unknown']);
export const MOMENT_KINDS = new Set(['highlight', 'action', 'calm', 'reaction', 'establishing']);
export const ISSUE_KINDS = new Set(['blurry', 'dark', 'overexposed', 'shaky', 'silent', 'noisy']);

/** Прямоугольник в долях кадра — единственная форма, в которой хранится объект. */
function normalizeBox(raw, field) {
  if (!raw || typeof raw !== 'object') return null;
  const x = clampNumber(raw.x, 0, 1, null);
  const y = clampNumber(raw.y, 0, 1, null);
  const w = clampNumber(raw.width, 0, 1, null);
  const h = clampNumber(raw.height, 0, 1, null);
  if ([x, y, w, h].some((v) => v === null) || w <= 0 || h <= 0) return null;

  // Прямоугольник не может вылезать за кадр: модель иногда отдаёт x+w > 1.
  return {
    x: Number(x.toFixed(4)),
    y: Number(y.toFixed(4)),
    width: Number(Math.min(w, 1 - x).toFixed(4)),
    height: Number(Math.min(h, 1 - y).toFixed(4)),
  };
}

/** Центр прямоугольника — то, ради чего он и нужен: удержание объекта в 9:16. */
export function boxCenter(box) {
  return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
}

function normalizeSubjects(raw, duration) {
  if (!Array.isArray(raw)) return [];

  return raw
    .slice(0, 20)
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const box = normalizeBox(item.box);
      if (!box) return null;

      return {
        kind: pickEnum(item.kind, SUBJECT_KINDS, 'unknown'),
        box,
        center: boxCenter(box),
        atSeconds: clampNumber(item.atSeconds, 0, duration, 0),
        confidence: clampNumber(item.confidence, 0, 1, 0.5),
        // Это единственное, что мы знаем о «человеке»: он есть и он вот тут.
        // Ни имени, ни признаков личности схема не предусматривает.
        isPrimary: item.isPrimary === true,
      };
    })
    .filter(Boolean);
}

function normalizeScenes(raw, duration) {
  if (!Array.isArray(raw)) return [];

  const scenes = raw
    .slice(0, 200)
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const start = clampNumber(item.start, 0, duration, null);
      const end = clampNumber(item.end, 0, duration, null);
      if (start === null || end === null || end - start < 0.05) return null;

      return {
        start: Number(start.toFixed(3)),
        end: Number(end.toFixed(3)),
        shotType: pickEnum(item.shotType, SHOT_TYPES, 'unknown'),
        motion: pickEnum(item.motion, MOTION_LEVELS, 'moderate'),
        quality: clampNumber(item.quality, 0, 1, 0.5),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);

  return scenes;
}

function normalizeMoments(raw, duration) {
  if (!Array.isArray(raw)) return [];

  return raw
    .slice(0, 40)
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const start = clampNumber(item.start, 0, duration, null);
      const end = clampNumber(item.end, 0, duration, null);
      if (start === null || end === null || end - start < 0.2) return null;

      return {
        start: Number(start.toFixed(3)),
        end: Number(end.toFixed(3)),
        kind: pickEnum(item.kind, MOMENT_KINDS, 'highlight'),
        score: clampNumber(item.score, 0, 1, 0.5),
        // Причина — для UI («почему ИИ выбрал этот фрагмент»), не для команд.
        reason: safeText(item.reason ?? '', { field: 'reason', maxLength: 160, allowEmpty: true }),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
}

function normalizeSpeech(raw, duration) {
  if (!raw || typeof raw !== 'object') {
    return { hasSpeech: false, language: null, segments: [] };
  }

  const segments = Array.isArray(raw.segments)
    ? raw.segments
        .slice(0, 300)
        .map((item) => {
          if (!item || typeof item !== 'object') return null;
          const start = clampNumber(item.start, 0, duration, null);
          const end = clampNumber(item.end, 0, duration, null);
          if (start === null || end === null || end - start < 0.05) return null;

          const text = safeText(item.text ?? '', {
            field: 'speech.text',
            maxLength: 300,
            allowEmpty: true,
          });
          if (!text) return null;

          const words = Array.isArray(item.words)
            ? item.words
                .slice(0, 60)
                .map((w) => {
                  if (!w || typeof w !== 'object') return null;
                  const wordText = safeText(w.text ?? '', {
                    field: 'speech.word',
                    maxLength: 60,
                    allowEmpty: true,
                  });
                  if (!wordText) return null;
                  return {
                    start: clampNumber(w.start, 0, duration, start),
                    end: clampNumber(w.end, 0, duration, end),
                    text: wordText,
                  };
                })
                .filter(Boolean)
            : [];

          return { start: Number(start.toFixed(3)), end: Number(end.toFixed(3)), text, words };
        })
        .filter(Boolean)
        .sort((a, b) => a.start - b.start)
    : [];

  return {
    hasSpeech: segments.length > 0,
    // BCP-47 короткий тег: две-три буквы плюс необязательный регион.
    language:
      typeof raw.language === 'string' && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(raw.language.trim())
        ? raw.language.trim()
        : null,
    segments,
  };
}

function normalizeIssues(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const issues = [];
  for (const item of raw.slice(0, 20)) {
    const kind = pickEnum(typeof item === 'string' ? item : item?.kind, ISSUE_KINDS, null);
    if (kind && !seen.has(kind)) {
      seen.add(kind);
      issues.push(kind);
    }
  }
  return issues;
}

/**
 * Строгая нормализация MediaAnalysis.
 *
 * @param {unknown} raw сырой объект (уже разобранный JSON от модели)
 * @param {{assetId: string, type: 'video'|'photo', durationSeconds: number,
 *          width: number, height: number}} context измеренное сервером
 * @returns {object} MediaAnalysis
 * @throws {UnsafeModelOutputError} если структура непригодна
 */
export function validateMediaAnalysis(raw, context) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new UnsafeModelOutputError('analysis', 'ответ не является объектом');
  }

  const duration = Number.isFinite(context.durationSeconds) ? Math.max(0, context.durationSeconds) : 0;

  const scenes = normalizeScenes(raw.scenes, duration);
  const subjects = normalizeSubjects(raw.subjects, duration);
  const moments = normalizeMoments(raw.moments, duration);
  const speech = normalizeSpeech(raw.speech, duration);

  // Видео без единой распознанной сцены — признак того, что модель ответила
  // мусором: сцена есть всегда, хотя бы одна на весь ролик.
  if (context.type === 'video' && duration > 0 && scenes.length === 0 && moments.length === 0) {
    throw new UnsafeModelOutputError('analysis.scenes', 'модель не вернула ни сцен, ни моментов');
  }

  const primary = subjects.find((s) => s.isPrimary) ?? subjects[0] ?? null;

  return {
    analysisVersion: ANALYSIS_VERSION,
    assetId: context.assetId,
    type: context.type,
    // Технические характеристики берутся ИЗМЕРЕННЫЕ, а не от модели.
    durationSeconds: duration,
    width: context.width ?? null,
    height: context.height ?? null,

    scenes,
    subjects,
    /** Точка, вокруг которой worker удерживает кадр при обрезке в 9:16. */
    framingCenter: primary ? primary.center : null,
    moments,
    speech,
    issues: normalizeIssues(raw.issues),
    quality: {
      overall: clampNumber(raw.quality?.overall, 0, 1, 0.5),
      sharpness: clampNumber(raw.quality?.sharpness, 0, 1, 0.5),
      exposure: clampNumber(raw.quality?.exposure, 0, 1, 0.5),
      stability: clampNumber(raw.quality?.stability, 0, 1, 0.5),
    },
    summary: safeText(raw.summary ?? '', {
      field: 'summary',
      maxLength: 300,
      allowEmpty: true,
    }),
  };
}

/**
 * Схема structured output для Gemini. Держится рядом с валидацией намеренно:
 * когда меняется одно, сразу видно второе.
 *
 * Полей с путями, именами файлов и любыми строками-командами здесь нет — и это
 * не забывчивость, а требование §15.
 */
export const GEMINI_ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    quality: {
      type: 'object',
      properties: {
        overall: { type: 'number' },
        sharpness: { type: 'number' },
        exposure: { type: 'number' },
        stability: { type: 'number' },
      },
    },
    scenes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          start: { type: 'number' },
          end: { type: 'number' },
          shotType: { type: 'string', enum: [...SHOT_TYPES] },
          motion: { type: 'string', enum: [...MOTION_LEVELS] },
          quality: { type: 'number' },
        },
        required: ['start', 'end'],
      },
    },
    subjects: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: [...SUBJECT_KINDS] },
          atSeconds: { type: 'number' },
          confidence: { type: 'number' },
          isPrimary: { type: 'boolean' },
          box: {
            type: 'object',
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
              width: { type: 'number' },
              height: { type: 'number' },
            },
            required: ['x', 'y', 'width', 'height'],
          },
        },
        required: ['kind', 'box'],
      },
    },
    moments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          start: { type: 'number' },
          end: { type: 'number' },
          kind: { type: 'string', enum: [...MOMENT_KINDS] },
          score: { type: 'number' },
          reason: { type: 'string' },
        },
        required: ['start', 'end'],
      },
    },
    issues: { type: 'array', items: { type: 'string', enum: [...ISSUE_KINDS] } },
  },
  required: ['scenes'],
};

/** Схема распознавания речи — отдельный вызов, отдельная схема. */
export const GEMINI_SPEECH_SCHEMA = {
  type: 'object',
  properties: {
    language: { type: 'string' },
    segments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          start: { type: 'number' },
          end: { type: 'number' },
          text: { type: 'string' },
          words: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                start: { type: 'number' },
                end: { type: 'number' },
                text: { type: 'string' },
              },
              required: ['text'],
            },
          },
        },
        required: ['start', 'end', 'text'],
      },
    },
  },
  required: ['segments'],
};
