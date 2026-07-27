// Разбор plan.json v2 и миграция планов v1 (§0, §7 контракта v2).
//
// Контракт требует, чтобы worker перепроверял план: backend — первая линия,
// worker — вторая. Здесь же план нормализуется в render spec, с которым дальше
// работает пайплайн.
//
// Обратная совместимость: план v1 принимается как есть и поднимается до v2.
// Поле `music` из v1 валидируется, но ИГНОРИРУЕТСЯ — фоновой музыки в продукте
// больше нет, и в FFmpeg оно не попадает ни при каких условиях.

import {
  ALLOWED_FPS,
  AUTO_RESOLUTION,
  CAPTION_POSITIONS,
  CAPTION_STYLES,
  CONTRACT_VERSION,
  EDIT_STYLES,
  EXPORT_PRESETS,
  HEX_COLOR_RE,
  ID_RE,
  MAX_CLIPS,
  MAX_DURATION_SECONDS,
  MAX_TEXT_OVERLAYS,
  MEDIA_TYPES,
  RESOLUTIONS,
  SUPPORTED_PLAN_VERSIONS,
  checkObjectPath,
} from './contract.js';
import { WorkerError } from './errors.js';
import { DEFAULT_FONT_ID, isKnownFont } from './fonts.js';
import { normalizeTransition } from './transitions.js';

function fail(code, message, field, detail) {
  throw new WorkerError(code, message, { field, detail });
}

function asObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('PLAN_INVALID', `Поле «${field}» должно быть объектом.`, field);
  }
  return value;
}

function parseAssets(rawAssets, projectPrefix) {
  if (!Array.isArray(rawAssets) || rawAssets.length === 0) {
    fail('PLAN_INVALID', 'В плане нет списка исходных материалов.', 'assets');
  }
  if (rawAssets.length > MAX_CLIPS) {
    fail('PLAN_INVALID', `Слишком много материалов (максимум ${MAX_CLIPS}).`, 'assets');
  }

  const byId = new Map();
  for (const [i, raw] of rawAssets.entries()) {
    const field = `assets[${i}]`;
    asObject(raw, field);

    if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) {
      fail('PLAN_INVALID', 'Идентификатор материала имеет недопустимый формат.', `${field}.id`);
    }
    if (byId.has(raw.id)) {
      fail('PLAN_INVALID', `Дублирующийся идентификатор материала «${raw.id}».`, `${field}.id`);
    }
    if (!MEDIA_TYPES.has(raw.type)) {
      fail('PLAN_INVALID', 'Тип материала должен быть video или photo.', `${field}.type`);
    }

    const pathError = checkObjectPath(raw.objectPath, projectPrefix);
    if (pathError) fail('INVALID_OBJECT_PATH', pathError, `${field}.objectPath`);

    byId.set(raw.id, {
      id: raw.id,
      type: raw.type,
      objectPath: raw.objectPath,
      sizeBytes: Number.isFinite(raw.sizeBytes) ? Math.round(raw.sizeBytes) : null,
      durationSeconds: Number.isFinite(raw.durationSeconds) ? Number(raw.durationSeconds) : null,
      width: Number.isFinite(raw.width) ? Math.round(raw.width) : null,
      height: Number.isFinite(raw.height) ? Math.round(raw.height) : null,
      checksumCrc32c: typeof raw.checksumCrc32c === 'string' ? raw.checksumCrc32c : null,
    });
  }
  return byId;
}

/** §1 v2 — переключатель звука. Поле `music` из v1 на него не влияет. */
function parseAudio(rawAudio, notes, hasLegacyMusic) {
  if (hasLegacyMusic) {
    // §0: принимаем ради старых клиентов, но в FFmpeg не передаём.
    notes.push('music-ignored: фоновая музыка удалена из продукта, поле plan.music не используется');
  }

  if (rawAudio == null) return { keepOriginal: true };
  const audio = asObject(rawAudio, 'plan.audio');
  return { keepOriginal: audio.keepOriginal !== false };
}

/** §6 v2 — субтитры: стили, позиция, шрифт и готовые реплики. */
function parseCaptions(raw, notes) {
  const captions = asObject(raw ?? {}, 'plan.captions');

  const style = captions.style ?? 'clean';
  if (!CAPTION_STYLES.has(style)) {
    fail('PLAN_INVALID', `Неизвестный стиль субтитров «${style}».`, 'plan.captions.style');
  }

  const colorHex = captions.colorHex ?? '#FFFFFF';
  if (!HEX_COLOR_RE.test(colorHex)) {
    fail('PLAN_INVALID', 'Цвет субтитров должен быть в формате #RRGGBB.', 'plan.captions.colorHex');
  }

  const highlight = captions.highlightColorHex ?? '#A855F7';
  if (!HEX_COLOR_RE.test(highlight)) {
    fail(
      'PLAN_INVALID',
      'Цвет выделения должен быть в формате #RRGGBB.',
      'plan.captions.highlightColorHex',
    );
  }

  let fontId = captions.fontId ?? DEFAULT_FONT_ID;
  if (!isKnownFont(fontId)) {
    notes.push(`font-fallback: субтитры — неизвестный шрифт «${fontId}», взят ${DEFAULT_FONT_ID}`);
    fontId = DEFAULT_FONT_ID;
  }

  const position = CAPTION_POSITIONS.has(captions.position) ? captions.position : 'bottom';

  // Реплики из распознавания речи. Worker сам речь не распознаёт (§6.1).
  const cues = Array.isArray(captions.cues)
    ? captions.cues
        .map((cue) => ({
          start: Math.max(0, Number(cue?.start) || 0),
          end: Math.max(0, Number(cue?.end) || 0),
          text: String(cue?.text ?? '').trim(),
          words: Array.isArray(cue?.words)
            ? cue.words
                .map((w) => ({
                  start: Math.max(0, Number(w?.start) || 0),
                  end: Math.max(0, Number(w?.end) || 0),
                  text: String(w?.text ?? '').trim(),
                  highlight: w?.highlight === true,
                }))
                .filter((w) => w.text)
            : [],
        }))
        .filter((cue) => cue.text && cue.end > cue.start)
        .sort((a, b) => a.start - b.start)
    : [];

  return {
    enabled: captions.enabled !== false,
    language: typeof captions.language === 'string' && captions.language ? captions.language : 'ru',
    style,
    colorHex: colorHex.toUpperCase(),
    highlightColorHex: highlight.toUpperCase(),
    fontId,
    position,
    maxLineChars: Math.round(Math.min(60, Math.max(8, Number(captions.maxLineChars) || 26))),
    // Форма v1: используется, только когда распознанных реплик нет.
    sampleText: typeof captions.sampleText === 'string' ? captions.sampleText.slice(0, 200).trim() : '',
    cues,
  };
}

/** §8 v2 — пресет перекрывает resolution и fps. */
function parseExport(raw) {
  const exp = asObject(raw ?? {}, 'export');

  let resolution = exp.resolution;
  let fps = Number(exp.fps ?? 30);
  let preset = null;

  if (exp.preset) {
    const spec = EXPORT_PRESETS[exp.preset];
    if (!spec) {
      fail('RESOLUTION_UNSUPPORTED', `Неизвестный пресет экспорта «${exp.preset}».`, 'export.preset');
    }
    preset = exp.preset;
    resolution = spec.resolution;
    fps = spec.fps;
  }

  if (resolution === AUTO_RESOLUTION) {
    fail(
      'RESOLUTION_UNSUPPORTED',
      'Разрешение экспорта не определено на сервере.',
      'export.resolution',
      'worker received unresolved maximumAvailable',
    );
  }

  const spec = RESOLUTIONS[resolution];
  if (!spec) {
    fail('RESOLUTION_UNSUPPORTED', `Неизвестное разрешение «${resolution}».`, 'export.resolution');
  }
  if (!ALLOWED_FPS.includes(fps)) {
    fail('PLAN_INVALID', `Недопустимая частота кадров «${exp.fps}».`, 'export.fps');
  }

  // Кадр — производная от resolution: присланным значениям не доверяем.
  return {
    preset,
    resolution,
    width: spec.width,
    height: spec.height,
    fps,
    videoBitrateKbps: spec.videoBitrateKbps,
    maxrateKbps: spec.maxrateKbps,
    audioBitrateKbps: spec.audioBitrateKbps,
    level: spec.level,
    isUpscale: Boolean(exp.isUpscale),
    estimatedSizeBytes: Number.isFinite(exp.estimatedSizeBytes)
      ? Math.round(exp.estimatedSizeBytes)
      : null,
  };
}

function parseClips(rawClips, assetsById) {
  if (!Array.isArray(rawClips) || rawClips.length === 0) {
    fail('PLAN_INVALID', 'План должен содержать хотя бы один клип.', 'plan.clips');
  }
  if (rawClips.length > MAX_CLIPS) {
    fail('PLAN_INVALID', `Слишком много клипов (максимум ${MAX_CLIPS}).`, 'plan.clips');
  }

  const seen = new Set();
  let total = 0;

  const clips = rawClips.map((raw, i) => {
    const field = `plan.clips[${i}]`;
    asObject(raw, field);

    const id = typeof raw.id === 'string' && raw.id ? raw.id : `clip_${i + 1}`;
    if (seen.has(id)) {
      fail('PLAN_INVALID', `Дублирующийся идентификатор клипа «${id}».`, `${field}.id`);
    }
    seen.add(id);

    if (typeof raw.mediaId !== 'string' || !raw.mediaId) {
      fail('PLAN_INVALID', 'Клип обязан ссылаться на материал через «mediaId».', `${field}.mediaId`);
    }
    const asset = assetsById.get(raw.mediaId);
    if (!asset) {
      fail('ASSET_MISSING', `Клип ссылается на неизвестный материал «${raw.mediaId}».`, `${field}.mediaId`);
    }

    const type = MEDIA_TYPES.has(raw.type) ? raw.type : asset.type;

    // §2: объект v2 либо строка v1 — обе формы законны.
    const transition = normalizeTransition(raw.transition);
    if (!transition) {
      fail('PLAN_INVALID', 'Недопустимый переход.', `${field}.transition`);
    }

    const duration = Number(raw.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      fail('PLAN_INVALID', 'Длительность клипа должна быть больше нуля.', `${field}.duration`);
    }

    let start = null;
    let end = null;
    if (type === 'video') {
      start = Number(raw.start ?? 0);
      end = Number(raw.end ?? start + duration);
      if (!Number.isFinite(start) || start < 0) {
        fail('PLAN_INVALID', 'Начало обрезки не может быть отрицательным.', `${field}.start`);
      }
      if (!Number.isFinite(end) || end - start < 0.1) {
        fail('PLAN_INVALID', 'Конец обрезки должен быть больше начала минимум на 0.1 с.', `${field}.end`);
      }
      if (asset.durationSeconds && end > asset.durationSeconds + 0.5) {
        fail('PLAN_INVALID', 'Обрезка выходит за пределы исходного материала.', `${field}.end`);
      }
    }

    total += duration;

    // §2.7 v1: filePath — локальный путь клиента, сервером не используется.
    return { id, mediaId: raw.mediaId, type, duration, start, end, transition };
  });

  if (total > MAX_DURATION_SECONDS + 0.001) {
    fail(
      'DURATION_EXCEEDED',
      `Суммарная длительность ${total.toFixed(1)} с превышает лимит ${MAX_DURATION_SECONDS} с.`,
      'plan.clips',
    );
  }

  return { clips, totalDuration: total };
}

/** §4 — здесь проверяется только структура: нормализация требует таймлайна. */
function parseTextOverlays(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    fail('PLAN_INVALID', 'Поле «textOverlays» должно быть массивом.', 'plan.textOverlays');
  }
  if (raw.length > MAX_TEXT_OVERLAYS) {
    fail(
      'PLAN_INVALID',
      `Слишком много текстовых слоёв (максимум ${MAX_TEXT_OVERLAYS}).`,
      'plan.textOverlays',
    );
  }
  return raw;
}

/**
 * Разбирает содержимое plan.json в render spec, поднимая v1 до v2.
 *
 * @param {unknown} document разобранный JSON plan.json
 * @param {{jobId: string, projectId: string, projectPrefix: string,
 *          contractVersion?: number}} ctx окружение задачи (§9 v1)
 */
export function parseRenderPlan(document, ctx) {
  const doc = asObject(document, 'plan.json');
  const editPlan = asObject(doc.plan ?? doc, 'plan');
  const notes = [];

  const version = Number(doc.contractVersion ?? ctx.contractVersion ?? CONTRACT_VERSION);
  if (!SUPPORTED_PLAN_VERSIONS.includes(version)) {
    fail(
      'CONTRACT_VERSION_UNSUPPORTED',
      `Поддерживаются версии контракта ${SUPPORTED_PLAN_VERSIONS.join(' и ')}.`,
      'contractVersion',
    );
  }
  if (version === 1) {
    notes.push('plan-migrated: план версии 1 поднят до версии 2');
  }

  const projectId = ctx.projectId;
  if (doc.projectId && doc.projectId !== projectId) {
    fail('PLAN_INVALID', 'План принадлежит другому проекту.', 'projectId', 'projectId mismatch');
  }
  if (doc.jobId && ctx.jobId && doc.jobId !== ctx.jobId) {
    fail('PLAN_INVALID', 'План принадлежит другой задаче рендера.', 'jobId', 'jobId mismatch');
  }

  if (typeof editPlan.id !== 'string' || !editPlan.id || editPlan.id.length > 128) {
    fail('PLAN_INVALID', 'План должен содержать строковый «id».', 'plan.id');
  }
  const style = editPlan.style ?? 'dynamicStyle';
  if (!EDIT_STYLES.has(style)) {
    fail('PLAN_INVALID', `Неизвестный стиль монтажа «${style}».`, 'plan.style');
  }

  const assetsById = parseAssets(doc.assets ?? editPlan.assets, ctx.projectPrefix);
  const { clips, totalDuration } = parseClips(editPlan.clips, assetsById);
  const exportSettings = parseExport(doc.export ?? editPlan.export);

  const coverClipId = typeof editPlan.coverClipId === 'string' ? editPlan.coverClipId : null;
  if (coverClipId && !clips.some((c) => c.id === coverClipId)) {
    fail('PLAN_INVALID', 'Обложка ссылается на несуществующий клип.', 'plan.coverClipId');
  }

  const usedMediaIds = new Set(clips.map((c) => c.mediaId));
  const assets = [...assetsById.values()].filter((a) => usedMediaIds.has(a.id));

  return {
    planVersion: version,
    contractVersion: CONTRACT_VERSION,
    planId: editPlan.id,
    projectId,
    jobId: ctx.jobId,
    style,
    audio: parseAudio(editPlan.audio, notes, editPlan.music != null),
    captions: parseCaptions(editPlan.captions, notes),
    textOverlays: parseTextOverlays(editPlan.textOverlays),
    coverClipId: coverClipId ?? clips[0].id,
    clips,
    assets,
    assetsById: new Map(assets.map((a) => [a.id, a])),
    export: exportSettings,
    totalDuration,
    notes,
  };
}
