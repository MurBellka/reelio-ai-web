// Разбор plan.json и повторная проверка инвариантов §2.
//
// Контракт (§2) прямо требует, чтобы worker перепроверял план: backend —
// первая линия, worker — вторая. Это единственный вход рендера, поэтому здесь
// же он нормализуется в render spec, с которым дальше работает пайплайн.
//
// Ожидаемая форма plan.json — снимок провалидированного RenderRequest:
//
//   { contractVersion, jobId, projectId, plan: EditPlan, assets: [...], export: {...} }
//
// Допускается и «плоский» вариант, где assets/export лежат внутри plan —
// правило совместимости §0 обязывает нас не ломаться на лишних полях.

import {
  ALLOWED_FPS,
  ALLOWED_TRANSITIONS,
  AUTO_RESOLUTION,
  CAPTION_STYLES,
  CONTRACT_VERSION,
  EDIT_STYLES,
  HEX_COLOR_RE,
  ID_RE,
  MAX_CLIPS,
  MAX_DURATION_SECONDS,
  MEDIA_TYPES,
  MUSIC_TRACKS,
  RESOLUTIONS,
  checkObjectPath,
} from './contract.js';
import { WorkerError } from './errors.js';

function fail(code, message, field, detail) {
  throw new WorkerError(code, message, { field, detail });
}

function asObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('PLAN_INVALID', `Поле «${field}» должно быть объектом.`, field);
  }
  return value;
}

function parseAssets(rawAssets, projectId) {
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

    const pathError = checkObjectPath(raw.objectPath, projectId);
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

function parseCaptions(raw) {
  const captions = asObject(raw ?? {}, 'plan.captions');
  const style = captions.style ?? 'clean';
  if (!CAPTION_STYLES.has(style)) {
    fail('PLAN_INVALID', `Неизвестный стиль субтитров «${style}».`, 'plan.captions.style');
  }
  const colorHex = captions.colorHex ?? '#FFFFFF';
  if (!HEX_COLOR_RE.test(colorHex)) {
    fail('PLAN_INVALID', 'Цвет субтитров должен быть в формате #RRGGBB.', 'plan.captions.colorHex');
  }
  return {
    enabled: captions.enabled !== false,
    language: typeof captions.language === 'string' && captions.language ? captions.language : 'ru',
    style,
    colorHex: colorHex.toUpperCase(),
    sampleText: typeof captions.sampleText === 'string' ? captions.sampleText.slice(0, 200).trim() : '',
  };
}

function parseMusic(raw) {
  const music = asObject(raw ?? {}, 'plan.music');
  const track = music.track ?? 'none';
  if (!MUSIC_TRACKS.has(track)) {
    fail('PLAN_INVALID', `Неизвестный трек «${track}».`, 'plan.music.track');
  }
  const volume = Number(music.volume ?? 0.7);
  if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
    fail('PLAN_INVALID', 'Громкость музыки должна быть в диапазоне 0..1.', 'plan.music.volume');
  }
  return { track, volume };
}

function parseExport(raw) {
  const exp = asObject(raw ?? {}, 'export');
  const resolution = exp.resolution;

  // §1: maximumAvailable резолвит ТОЛЬКО backend. Worker обязан получить
  // конкретное разрешение, иначе размер кадра неоднозначен.
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

  const fps = Number(exp.fps ?? 30);
  if (!ALLOWED_FPS.includes(fps)) {
    fail('PLAN_INVALID', `Недопустимая частота кадров «${exp.fps}».`, 'export.fps');
  }

  // Ширину и высоту берём из таблицы §1, а не из запроса: они — производные от
  // resolution, и присланные значения не должны их переопределять.
  return {
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

    const transition = raw.transition ?? 'cut';
    if (!ALLOWED_TRANSITIONS.has(transition)) {
      fail('PLAN_INVALID', `Недопустимый переход «${transition}».`, `${field}.transition`);
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

    return {
      id,
      mediaId: raw.mediaId,
      type,
      duration,
      start,
      end,
      transition,
      // §2.7: filePath — локальный путь клиента, сервером не используется.
      // Он намеренно не переносится в render spec.
    };
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

/**
 * Разбирает содержимое plan.json в render spec.
 *
 * @param {unknown} document разобранный JSON plan.json
 * @param {{jobId: string, projectId: string, contractVersion?: number}} ctx окружение задачи (§9)
 */
export function parseRenderPlan(document, ctx) {
  const doc = asObject(document, 'plan.json');
  const editPlan = asObject(doc.plan ?? doc, 'plan');

  const version = doc.contractVersion ?? ctx.contractVersion ?? CONTRACT_VERSION;
  if (Number(version) !== CONTRACT_VERSION) {
    fail(
      'CONTRACT_VERSION_UNSUPPORTED',
      `Поддерживается только версия контракта ${CONTRACT_VERSION}.`,
      'contractVersion',
    );
  }

  // projectId из окружения — источник истины: именно он ограничивает пути (§6).
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

  const assetsById = parseAssets(doc.assets ?? editPlan.assets, projectId);
  const { clips, totalDuration } = parseClips(editPlan.clips, assetsById);
  const exportSettings = parseExport(doc.export ?? editPlan.export);

  const coverClipId = typeof editPlan.coverClipId === 'string' ? editPlan.coverClipId : null;
  if (coverClipId && !clips.some((c) => c.id === coverClipId)) {
    fail('PLAN_INVALID', 'Обложка ссылается на несуществующий клип.', 'plan.coverClipId');
  }

  // Материалы, на которые никто не ссылается, скачивать незачем.
  const usedMediaIds = new Set(clips.map((c) => c.mediaId));
  const assets = [...assetsById.values()].filter((a) => usedMediaIds.has(a.id));

  return {
    planId: editPlan.id,
    projectId,
    jobId: ctx.jobId,
    style,
    captions: parseCaptions(editPlan.captions),
    music: parseMusic(editPlan.music),
    coverClipId: coverClipId ?? clips[0].id,
    clips,
    assets,
    assetsById: new Map(assets.map((a) => [a.id, a])),
    export: exportSettings,
    totalDuration,
  };
}
