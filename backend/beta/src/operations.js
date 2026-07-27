// Команды пользователя как операции над планом (§8 задания).
//
// Ключевое архитектурное решение: модель **не пишет план**. Она возвращает
// список операций из закрытого перечня, каждая — с параметрами, которые сервер
// сверяет с каталогом, зажимает в диапазоны и проверяет по реальным
// идентификаторам клипов. Собирает и применяет операции сервер.
//
// Отсюда следует §15: что бы модель ни вернула, она не может назвать файл,
// собрать путь или задать фильтр — таких параметров у операций просто нет.
//
// Поддерживаемые команды (по заданию):
//   addText      — поставить текст в указанное место и время
//   styleText    — выбрать шрифт, цвет и анимацию
//   trimClip     — ускорить начало (обрезать вступление)
//   removeClip   — убрать фрагмент
//   reorderClips — переставить фрагменты
//   setTransition— выбрать переход
//   setAudio     — сохранить оригинальный звук или экспортировать без звука
//   setCaptions  — настроить субтитры

import {
  ANCHOR_Y,
  CAPTION_POSITIONS,
  CAPTION_STYLES,
  FONT_IDS,
  FONT_WEIGHTS,
  MAX_FONT_SIZE_RATIO,
  MAX_TEXT_LENGTH,
  MAX_TRANSITION_SECONDS,
  MIN_FONT_SIZE_RATIO,
  MIN_TRANSITION_SECONDS,
  TEXT_ALIGNS,
  TEXT_ANCHORS,
  TEXT_ANIMATIONS,
  TRANSITION_INTENSITIES,
  canonicalTransitionType,
} from './catalog.js';
import { PROJECT_LIMITS } from './limits.js';
import { clampNumber, pickEnum, pickKnownId, safeColor, safeText } from './sanitize.js';

export const OPERATION_TYPES = [
  'addText',
  'styleText',
  'trimClip',
  'removeClip',
  'reorderClips',
  'setTransition',
  'setAudio',
  'setCaptions',
];

/** Схема structured output для операций. Полей-строк со свободной формой два:
 *  текст подписи и id, и оба проверяются сервером. */
export const GEMINI_OPERATIONS_SCHEMA = {
  type: 'object',
  properties: {
    operations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: OPERATION_TYPES },
          clipId: { type: 'string' },
          targetId: { type: 'string' },
          order: { type: 'array', items: { type: 'string' } },
          text: { type: 'string' },
          startSeconds: { type: 'number' },
          endSeconds: { type: 'number' },
          anchor: { type: 'string', enum: TEXT_ANCHORS },
          x: { type: 'number' },
          y: { type: 'number' },
          fontId: { type: 'string', enum: FONT_IDS },
          fontWeight: { type: 'string', enum: FONT_WEIGHTS },
          fontSizeRatio: { type: 'number' },
          colorHex: { type: 'string' },
          align: { type: 'string', enum: TEXT_ALIGNS },
          animation: { type: 'string', enum: TEXT_ANIMATIONS },
          transitionType: { type: 'string' },
          durationSeconds: { type: 'number' },
          intensity: { type: 'string', enum: TRANSITION_INTENSITIES },
          keepOriginal: { type: 'boolean' },
          enabled: { type: 'boolean' },
          style: { type: 'string', enum: CAPTION_STYLES },
          position: { type: 'string', enum: CAPTION_POSITIONS },
          highlightColorHex: { type: 'string' },
        },
        required: ['op'],
      },
    },
  },
  required: ['operations'],
};

const MAX_OPERATIONS = 40;

/**
 * Нормализует одну операцию.
 *
 * @param {object} raw операция от модели
 * @param {{clipIds: Set<string>, textIds: Set<string>, maxDuration: number}} ctx
 * @returns {{op: object|null, warning: string|null}}
 */
function normalizeOperation(raw, ctx) {
  if (!raw || typeof raw !== 'object') return { op: null, warning: 'операция не объект' };

  const op = pickEnum(raw.op, OPERATION_TYPES, null);
  if (!op) return { op: null, warning: `неизвестная операция «${raw.op}»` };

  switch (op) {
    case 'addText': {
      // Текст — единственное свободное поле; safeText отвергнет путь и команду.
      const text = safeText(raw.text, { field: 'addText.text', maxLength: MAX_TEXT_LENGTH });
      const clipId = raw.clipId ? pickKnownId(raw.clipId, ctx.clipIds) : null;
      if (raw.clipId && !clipId) {
        return { op: null, warning: `addText ссылается на неизвестный клип «${raw.clipId}»` };
      }

      const anchor = pickEnum(raw.anchor, TEXT_ANCHORS, 'bottom');
      const start = clampNumber(raw.startSeconds, 0, ctx.maxDuration, 0);
      const end = clampNumber(raw.endSeconds, 0, ctx.maxDuration, start + 3);
      if (end - start < 0.2) return { op: null, warning: 'addText: слишком короткий интервал' };

      return {
        op: {
          op,
          clipId,
          text,
          startSeconds: start,
          endSeconds: end,
          anchor,
          x: clampNumber(raw.x, 0, 1, 0.5),
          y: clampNumber(raw.y, 0, 1, ANCHOR_Y[anchor]),
          fontId: pickEnum(raw.fontId, FONT_IDS, null),
          fontWeight: pickEnum(raw.fontWeight, FONT_WEIGHTS, 'bold'),
          fontSizeRatio: clampNumber(
            raw.fontSizeRatio,
            MIN_FONT_SIZE_RATIO,
            MAX_FONT_SIZE_RATIO,
            0.055,
          ),
          colorHex: safeColor(raw.colorHex, '#FFFFFF'),
          align: pickEnum(raw.align, TEXT_ALIGNS, 'center'),
          animation: pickEnum(raw.animation, TEXT_ANIMATIONS, 'fade'),
        },
        warning: null,
      };
    }

    case 'styleText': {
      const targetId = pickKnownId(raw.targetId, ctx.textIds);
      if (!targetId) {
        return { op: null, warning: `styleText ссылается на неизвестный слой «${raw.targetId}»` };
      }
      return {
        op: {
          op,
          targetId,
          fontId: pickEnum(raw.fontId, FONT_IDS, null),
          fontWeight: pickEnum(raw.fontWeight, FONT_WEIGHTS, null),
          colorHex: raw.colorHex ? safeColor(raw.colorHex, null) : null,
          animation: pickEnum(raw.animation, TEXT_ANIMATIONS, null),
        },
        warning: null,
      };
    }

    case 'trimClip': {
      const clipId = pickKnownId(raw.clipId, ctx.clipIds);
      if (!clipId) {
        return { op: null, warning: `trimClip ссылается на неизвестный клип «${raw.clipId}»` };
      }
      const start = clampNumber(raw.startSeconds, 0, PROJECT_LIMITS.maxVideoDurationSeconds, null);
      const end = clampNumber(raw.endSeconds, 0, PROJECT_LIMITS.maxVideoDurationSeconds, null);
      if (start === null || end === null || end - start < 0.2) {
        return { op: null, warning: 'trimClip: некорректный интервал' };
      }
      return { op: { op, clipId, startSeconds: start, endSeconds: end }, warning: null };
    }

    case 'removeClip': {
      const clipId = pickKnownId(raw.clipId, ctx.clipIds);
      if (!clipId) {
        return { op: null, warning: `removeClip ссылается на неизвестный клип «${raw.clipId}»` };
      }
      return { op: { op, clipId }, warning: null };
    }

    case 'reorderClips': {
      if (!Array.isArray(raw.order)) return { op: null, warning: 'reorderClips: order не массив' };

      const order = [];
      const seen = new Set();
      for (const id of raw.order) {
        const known = pickKnownId(id, ctx.clipIds);
        // Дубликат в перестановке потерял бы клип — такую операцию не применяем.
        if (!known || seen.has(known)) {
          return { op: null, warning: 'reorderClips: неизвестный или повторяющийся клип' };
        }
        seen.add(known);
        order.push(known);
      }
      if (order.length === 0) return { op: null, warning: 'reorderClips: пустой порядок' };

      return { op: { op, order }, warning: null };
    }

    case 'setTransition': {
      const clipId = pickKnownId(raw.clipId, ctx.clipIds);
      if (!clipId) {
        return { op: null, warning: `setTransition ссылается на неизвестный клип «${raw.clipId}»` };
      }
      const type = canonicalTransitionType(raw.transitionType);
      if (!type) {
        return { op: null, warning: `неизвестный переход «${raw.transitionType}»` };
      }
      const duration =
        raw.durationSeconds === undefined || raw.durationSeconds === null
          ? null
          : clampNumber(raw.durationSeconds, MIN_TRANSITION_SECONDS, MAX_TRANSITION_SECONDS, null);

      return {
        op: {
          op,
          clipId,
          transitionType: type,
          durationSeconds: duration,
          intensity: pickEnum(raw.intensity, TRANSITION_INTENSITIES, 'balanced'),
        },
        warning: null,
      };
    }

    case 'setAudio': {
      // §1 контракта v2: ровно два состояния, третьего не предусмотрено.
      if (typeof raw.keepOriginal !== 'boolean') {
        return { op: null, warning: 'setAudio: keepOriginal должен быть булевым' };
      }
      return { op: { op, keepOriginal: raw.keepOriginal }, warning: null };
    }

    case 'setCaptions': {
      return {
        op: {
          op,
          enabled: typeof raw.enabled === 'boolean' ? raw.enabled : null,
          style: pickEnum(raw.style, CAPTION_STYLES, null),
          position: pickEnum(raw.position, CAPTION_POSITIONS, null),
          fontId: pickEnum(raw.fontId, FONT_IDS, null),
          colorHex: raw.colorHex ? safeColor(raw.colorHex, null) : null,
          highlightColorHex: raw.highlightColorHex ? safeColor(raw.highlightColorHex, null) : null,
        },
        warning: null,
      };
    }

    default:
      return { op: null, warning: `операция ${op} не реализована` };
  }
}

/**
 * Нормализует список операций от модели.
 *
 * Некорректные операции **отбрасываются с предупреждением**, а не роняют весь
 * запрос: одна выдуманная модельная ссылка не повод терять остальные девять
 * осмысленных правок. Но текст, похожий на команду, — это уже не «промах
 * модели», и safeText бросает исключение.
 *
 * @returns {{operations: object[], warnings: string[]}}
 */
export function normalizeOperations(raw, ctx) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.operations) ? raw.operations : null;
  if (!list) return { operations: [], warnings: ['ответ не содержит списка операций'] };

  const operations = [];
  const warnings = [];

  for (const item of list.slice(0, MAX_OPERATIONS)) {
    const { op, warning } = normalizeOperation(item, ctx);
    if (op) operations.push(op);
    else if (warning) warnings.push(warning);
  }

  if (list.length > MAX_OPERATIONS) {
    warnings.push(`операций больше ${MAX_OPERATIONS}, лишние отброшены`);
  }

  return { operations, warnings };
}
