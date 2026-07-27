// Сборка EditPlan v2 (§8 задания, §2–§8 контракта v2).
//
// План собирает СЕРВЕР. Модель влияет на него двумя способами: даёт анализ
// (какие фрагменты удачные) и список операций (что поправить). Ни то, ни
// другое не превращается в строку, попадающую в FFmpeg, — этим и обеспечено
// требование §15.
//
// Музыкальных полей в плане нет ни при каких условиях (§9): их нет ни в
// черновике, ни среди операций, ни в результате.

import {
  ANCHOR_Y,
  CAPTION_STYLES,
  DEFAULT_FONT_ID,
  MAX_CLIPS,
  MAX_TEXT_OVERLAYS,
  SAFE_ZONE,
  TRANSITION_TYPES,
} from './catalog.js';
import { PROJECT_LIMITS } from './limits.js';
import { assertNoCommandLikeStrings, clampNumber } from './sanitize.js';

/** Минимальная и максимальная длина клипа в автоматической сборке. */
const MIN_CLIP_SECONDS = 1.2;
const MAX_CLIPS_SECONDS = 6;

/** Переходы, которые автосборка выбирает по характеру материала. */
const TRANSITION_BY_MOTION = {
  static: 'dissolve',
  slow: 'dissolve',
  moderate: 'slideLeft',
  fast: 'zoomIn',
};

export class PlanValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'PlanValidationError';
    this.code = 'PLAN_INVALID';
    this.field = field;
  }
}

/**
 * Черновик плана из результатов анализа.
 *
 * Логика простая и предсказуемая: берём лучшие моменты каждого материала,
 * ограничиваем их длину, укладываемся в лимит длительности. Это не «магия
 * ИИ», а детерминированный отбор по оценкам, которые дал анализ, — поэтому
 * результат воспроизводим и его легко объяснить пользователю.
 *
 * @param {{analyses: object[], targetDurationSeconds?: number,
 *          verifiedTransitions?: string[]}} opts
 */
export function buildDraftPlan({ analyses, targetDurationSeconds, verifiedTransitions } = {}) {
  const allowed = new Set(
    Array.isArray(verifiedTransitions) && verifiedTransitions.length > 0
      ? verifiedTransitions
      : TRANSITION_TYPES,
  );
  const target = clampNumber(
    targetDurationSeconds ?? 30,
    5,
    PROJECT_LIMITS.maxOutputDurationSeconds,
    30,
  );

  const candidates = [];
  for (const analysis of analyses ?? []) {
    if (analysis.type === 'photo') {
      candidates.push({
        mediaId: analysis.assetId,
        type: 'photo',
        duration: 2.5,
        score: analysis.quality?.overall ?? 0.5,
        motion: 'static',
      });
      continue;
    }

    // Для видео берём моменты; если их нет — середину самой длинной сцены.
    const moments = analysis.moments?.length
      ? analysis.moments
      : (analysis.scenes ?? [])
          .map((s) => ({ start: s.start, end: s.end, score: s.quality ?? 0.5 }))
          .sort((a, b) => b.end - b.start - (a.end - a.start))
          .slice(0, 2);

    for (const moment of moments.slice(0, 4)) {
      const rawLength = moment.end - moment.start;
      if (rawLength < 0.5) continue;

      const duration = Math.min(MAX_CLIPS_SECONDS, Math.max(MIN_CLIP_SECONDS, rawLength));
      const scene = (analysis.scenes ?? []).find(
        (s) => moment.start >= s.start && moment.start < s.end,
      );

      candidates.push({
        mediaId: analysis.assetId,
        type: 'video',
        start: Number(moment.start.toFixed(3)),
        end: Number(Math.min(moment.start + duration, analysis.durationSeconds).toFixed(3)),
        duration: Number(duration.toFixed(3)),
        score: moment.score ?? 0.5,
        motion: scene?.motion ?? 'moderate',
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  const clips = [];
  let total = 0;
  for (const candidate of candidates) {
    if (clips.length >= MAX_CLIPS) break;
    if (total + candidate.duration > target) continue;

    const preferred = TRANSITION_BY_MOTION[candidate.motion] ?? 'dissolve';
    const type = clips.length === 0 ? 'cut' : allowed.has(preferred) ? preferred : 'dissolve';

    clips.push({
      id: `clip_${clips.length + 1}`,
      mediaId: candidate.mediaId,
      type: candidate.type,
      duration: candidate.duration,
      start: candidate.type === 'video' ? candidate.start : null,
      end: candidate.type === 'video' ? candidate.end : null,
      transition: { type, durationSeconds: null, intensity: 'balanced' },
    });
    total += candidate.duration;
  }

  return clips;
}

/** Реплики субтитров из распознанной речи, сдвинутые на таймлайн ролика. */
function captionsFromSpeech(clips, analyses) {
  const byAsset = new Map((analyses ?? []).map((a) => [a.assetId, a]));
  const cues = [];
  let timelineStart = 0;

  for (const clip of clips) {
    const analysis = byAsset.get(clip.mediaId);
    const segments = analysis?.speech?.segments ?? [];

    for (const segment of segments) {
      // Берём только то, что попадает в вырезанный кусок исходника.
      const clipStart = clip.start ?? 0;
      const clipEnd = clip.end ?? clipStart + clip.duration;
      if (segment.end <= clipStart || segment.start >= clipEnd) continue;

      const start = timelineStart + Math.max(0, segment.start - clipStart);
      const end = timelineStart + Math.min(clip.duration, segment.end - clipStart);
      if (end - start < 0.2) continue;

      cues.push({
        start: Number(start.toFixed(3)),
        end: Number(end.toFixed(3)),
        text: segment.text,
        words: (segment.words ?? []).map((w) => ({
          start: Number((timelineStart + Math.max(0, w.start - clipStart)).toFixed(3)),
          end: Number((timelineStart + Math.max(0, w.end - clipStart)).toFixed(3)),
          text: w.text,
          highlight: false,
        })),
      });
    }
    timelineStart += clip.duration;
  }

  return cues.sort((a, b) => a.start - b.start);
}

/** Пустой план v2 с безопасными значениями по умолчанию. */
export function emptyPlan({ planId, prompt = '' }) {
  return {
    id: planId,
    prompt: String(prompt).slice(0, 2000),
    style: 'dynamicStyle',
    durationSeconds: 0,
    // §1 v2: по умолчанию оригинальный звук сохраняется.
    audio: { keepOriginal: true },
    captions: {
      enabled: true,
      language: 'ru',
      style: 'bold',
      colorHex: '#FFFFFF',
      highlightColorHex: '#A855F7',
      fontId: DEFAULT_FONT_ID,
      position: 'bottom',
      maxLineChars: 26,
      cues: [],
    },
    textOverlays: [],
    coverClipId: null,
    clips: [],
  };
}

/** Применяет одну нормализованную операцию к плану. */
function applyOperation(plan, op, warnings) {
  switch (op.op) {
    case 'addText': {
      if (plan.textOverlays.length >= MAX_TEXT_OVERLAYS) {
        warnings.push(`addText: достигнут лимит ${MAX_TEXT_OVERLAYS} текстовых слоёв`);
        return;
      }
      plan.textOverlays.push({
        id: `text_${plan.textOverlays.length + 1}`,
        text: op.text,
        clipId: op.clipId,
        startSeconds: op.startSeconds,
        endSeconds: op.endSeconds,
        position: { anchor: op.anchor, x: op.x, y: op.y },
        fontId: op.fontId ?? DEFAULT_FONT_ID,
        fontWeight: op.fontWeight,
        fontSizeRatio: op.fontSizeRatio,
        colorHex: op.colorHex,
        align: op.align,
        opacity: 1,
        animation: op.animation,
      });
      return;
    }

    case 'styleText': {
      const overlay = plan.textOverlays.find((t) => t.id === op.targetId);
      if (!overlay) {
        warnings.push(`styleText: слой ${op.targetId} исчез до применения`);
        return;
      }
      if (op.fontId) overlay.fontId = op.fontId;
      if (op.fontWeight) overlay.fontWeight = op.fontWeight;
      if (op.colorHex) overlay.colorHex = op.colorHex;
      if (op.animation) overlay.animation = op.animation;
      return;
    }

    case 'trimClip': {
      const clip = plan.clips.find((c) => c.id === op.clipId);
      if (!clip) return;
      if (clip.type === 'photo') {
        // У фото нет исходного таймкода — меняется только длина на таймлайне.
        clip.duration = Number((op.endSeconds - op.startSeconds).toFixed(3));
        return;
      }
      clip.start = op.startSeconds;
      clip.end = op.endSeconds;
      clip.duration = Number((op.endSeconds - op.startSeconds).toFixed(3));
      return;
    }

    case 'removeClip': {
      const remaining = plan.clips.filter((c) => c.id !== op.clipId);
      // Удалять последний клип нельзя: пустой план невалиден, а молча выкинуть
      // команду честнее, чем отдать пользователю сломанный проект.
      if (remaining.length === 0) {
        warnings.push('removeClip: нельзя удалить единственный клип');
        return;
      }
      plan.clips = remaining;
      return;
    }

    case 'reorderClips': {
      const byId = new Map(plan.clips.map((c) => [c.id, c]));
      const reordered = op.order.map((id) => byId.get(id)).filter(Boolean);
      // Клипы, не упомянутые в перестановке, сохраняем в конце — иначе
      // частичная команда молча потеряла бы материал.
      for (const clip of plan.clips) {
        if (!op.order.includes(clip.id)) reordered.push(clip);
      }
      plan.clips = reordered;
      return;
    }

    case 'setTransition': {
      const index = plan.clips.findIndex((c) => c.id === op.clipId);
      if (index < 0) return;
      if (index === 0) {
        warnings.push('setTransition: у первого клипа перехода нет');
        return;
      }
      plan.clips[index].transition = {
        type: op.transitionType,
        durationSeconds: op.durationSeconds,
        intensity: op.intensity,
      };
      return;
    }

    case 'setAudio': {
      plan.audio.keepOriginal = op.keepOriginal;
      return;
    }

    case 'setCaptions': {
      if (op.enabled !== null) plan.captions.enabled = op.enabled;
      if (op.style) plan.captions.style = op.style;
      if (op.position) plan.captions.position = op.position;
      if (op.fontId) plan.captions.fontId = op.fontId;
      if (op.colorHex) plan.captions.colorHex = op.colorHex;
      if (op.highlightColorHex) plan.captions.highlightColorHex = op.highlightColorHex;
      return;
    }

    default:
      warnings.push(`операция ${op.op} не применена`);
  }
}

/**
 * Финальная проверка плана перед отправкой в worker (§7).
 *
 * @throws {PlanValidationError}
 */
export function validatePlan(plan) {
  if (!Array.isArray(plan.clips) || plan.clips.length === 0) {
    throw new PlanValidationError('План должен содержать хотя бы один клип.', 'clips');
  }
  if (plan.clips.length > MAX_CLIPS) {
    throw new PlanValidationError(`Слишком много клипов (максимум ${MAX_CLIPS}).`, 'clips');
  }

  const total = plan.clips.reduce((sum, c) => sum + c.duration, 0);
  if (total > PROJECT_LIMITS.maxOutputDurationSeconds + 0.001) {
    throw new PlanValidationError(
      `Ролик длиннее ${PROJECT_LIMITS.maxOutputDurationSeconds} секунд.`,
      'clips',
    );
  }

  const ids = new Set();
  for (const clip of plan.clips) {
    if (ids.has(clip.id)) throw new PlanValidationError(`Дублирующийся клип ${clip.id}.`, 'clips');
    ids.add(clip.id);
    if (!(clip.duration > 0)) {
      throw new PlanValidationError('Длительность клипа должна быть больше нуля.', 'clips');
    }
  }

  if (plan.textOverlays.length > MAX_TEXT_OVERLAYS) {
    throw new PlanValidationError('Слишком много текстовых слоёв.', 'textOverlays');
  }
  if (!CAPTION_STYLES.includes(plan.captions.style)) {
    throw new PlanValidationError('Неизвестный стиль субтитров.', 'captions.style');
  }
  if (typeof plan.audio?.keepOriginal !== 'boolean') {
    throw new PlanValidationError('Не задан режим звука.', 'audio.keepOriginal');
  }

  // §9: музыкальных полей быть не должно даже случайно.
  if ('music' in plan) {
    throw new PlanValidationError('Поле музыки не поддерживается.', 'music');
  }

  // §15: последний рубеж — ни одна строка плана не похожа на путь или команду.
  assertNoCommandLikeStrings(plan);

  return plan;
}

/**
 * Полная сборка: черновик из анализа → применение операций → проверка.
 *
 * @param {{planId: string, prompt?: string, analyses: object[],
 *          operations?: object[], targetDurationSeconds?: number,
 *          verifiedTransitions?: string[]}} input
 * @returns {{plan: object, warnings: string[]}}
 */
export function assemblePlan(input) {
  const warnings = [];
  const plan = emptyPlan({ planId: input.planId, prompt: input.prompt });

  plan.clips = buildDraftPlan({
    analyses: input.analyses,
    targetDurationSeconds: input.targetDurationSeconds,
    verifiedTransitions: input.verifiedTransitions,
  });

  if (plan.clips.length === 0) {
    throw new PlanValidationError('Из материалов не удалось собрать ни одного фрагмента.', 'clips');
  }

  for (const op of input.operations ?? []) {
    applyOperation(plan, op, warnings);
  }

  // Идентификаторы клипов перенумеровываем после перестановок и удалений,
  // иначе coverClipId и привязки текста будут указывать не туда.
  const renumbered = new Map();
  plan.clips.forEach((clip, index) => {
    const newId = `clip_${index + 1}`;
    renumbered.set(clip.id, newId);
    clip.id = newId;
    // Первый клип перехода не имеет по определению.
    if (index === 0) clip.transition = { type: 'cut', durationSeconds: null, intensity: 'balanced' };
  });
  for (const overlay of plan.textOverlays) {
    if (overlay.clipId) overlay.clipId = renumbered.get(overlay.clipId) ?? null;
  }

  plan.coverClipId = plan.clips[0].id;
  plan.durationSeconds = Math.round(plan.clips.reduce((sum, c) => sum + c.duration, 0));
  plan.captions.cues = plan.captions.enabled ? captionsFromSpeech(plan.clips, input.analyses) : [];

  // Текст за безопасной зоной подвинем здесь же: пользователь увидит
  // предупреждение ещё до рендера, а не постфактум в логе worker'а.
  for (const overlay of plan.textOverlays) {
    const clampedY = Math.min(Math.max(overlay.position.y, SAFE_ZONE.top), 1 - SAFE_ZONE.bottom);
    const clampedX = Math.min(Math.max(overlay.position.x, SAFE_ZONE.left), 1 - SAFE_ZONE.right);
    if (clampedY !== overlay.position.y || clampedX !== overlay.position.x) {
      warnings.push(`Текст «${overlay.text.slice(0, 20)}» сдвинут в безопасную зону.`);
      overlay.position.x = clampedX;
      overlay.position.y = clampedY;
    }
  }

  validatePlan(plan);
  return { plan, warnings };
}

export { ANCHOR_Y };
