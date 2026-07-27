// Сборка командной строки FFmpeg: входы, filter_complex, параметры кодека.
//
// Модуль намеренно чистый — никакого ввода-вывода. На вход идут план, таймлайн
// и результаты ffprobe, на выход — массив аргументов. Благодаря этому весь
// монтаж (кадрирование, переходы, текст, субтитры) проверяется тестами без
// запуска FFmpeg, а e2e остаётся тонкой проверкой «оно и правда собирает
// валидный MP4».
//
// Звук здесь не строится: им занимается audio.js. Музыки в тракте нет вовсе.

import { buildAudioGraph } from './audio.js';
import { levelToX264 } from './contract.js';
import { FALLBACK_TRANSITION, TRANSITION_CATALOG, canonicalTransition } from './transitions.js';

/** Насколько канва под zoompan больше кадра (запас на приближение). */
const KEN_BURNS_CANVAS = 1.4;
const KEN_BURNS_MAX_ZOOM = 1.18;

/**
 * Опции scale, общие для всех цепочек.
 *
 * `out_range=tv` обязателен: JPEG и другие фотоисточники приходят в полном
 * диапазоне (pc), и без явного приведения libx264 пометит поток как yuvj420p —
 * а §1 требует ровно yuv420p.
 */
const SCALE_OPTS = 'flags=bicubic:in_range=auto:out_range=tv';

/**
 * Экранирование пути внутри аргумента фильтра: FFmpeg трактует «:» как
 * разделитель опций, а «,» и «;» — как границы фильтров.
 *
 * Через эту функцию проходят ТОЛЬКО пути к файлам, которые формирует сам
 * worker. Пользовательский текст в filter_complex не попадает никогда — он
 * живёт в .ass файле (§4.3).
 */
export function escapeFilterPath(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/([,;[\]])/g, '\\$1');
}

/** Цепочка вписывания кадра в 9:16 — всегда с сохранением пропорций. */
export function fitChain(fitMode, width, height) {
  if (fitMode === 'contain') {
    return [
      `scale=${width}:${height}:force_original_aspect_ratio=decrease:${SCALE_OPTS}`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    ].join(',');
  }
  // cover: масштаб «в накрытие» + центральный кроп. Растяжения нет — лишнее
  // обрезается. Поведение по умолчанию для вертикальных роликов.
  return [
    `scale=${width}:${height}:force_original_aspect_ratio=increase:${SCALE_OPTS}`,
    `crop=${width}:${height}`,
  ].join(',');
}

/** Ken Burns: четыре детерминированных движения, чередуются по индексу клипа. */
export function kenBurnsExpressions(index, frames) {
  const n = Math.max(1, frames - 1);
  const variant = index % 4;
  const center = { x: 'iw/2-(iw/zoom/2)', y: 'ih/2-(ih/zoom/2)' };
  const amp = (KEN_BURNS_MAX_ZOOM - 1).toFixed(3);

  if (variant === 0) return { z: `1+${amp}*on/${n}`, x: center.x, y: center.y, name: 'zoom-in' };
  if (variant === 1) {
    return { z: `${KEN_BURNS_MAX_ZOOM}-${amp}*on/${n}`, x: center.x, y: center.y, name: 'zoom-out' };
  }
  if (variant === 2) {
    return { z: `${KEN_BURNS_MAX_ZOOM}`, x: `(iw-iw/zoom)*on/${n}`, y: center.y, name: 'pan-right' };
  }
  return { z: `${KEN_BURNS_MAX_ZOOM}`, x: center.x, y: `(ih-ih/zoom)*(1-on/${n})`, name: 'pan-up' };
}

/**
 * Аргументы одного входа FFmpeg для клипа.
 *
 * Про rotation: флаг `-autorotate` намеренно НЕ передаётся. Автоповорот и так
 * включён по умолчанию, а его синтаксис несовместим между версиями FFmpeg.
 * Нормализация обеспечивается декодером (применяет display matrix) и
 * probe.displayDimensions() (даёт уже развёрнутые размеры для кадрирования).
 */
function inputArgsForClip(segment, source, fps) {
  const clip = segment.clip;
  if (clip.type === 'photo') {
    return ['-loop', '1', '-framerate', String(fps), '-t', clip.duration.toFixed(3), '-i', source.filePath];
  }

  const start = Math.max(0, Number(clip.start) || 0);
  const sourceSpan = Math.max(0.1, Number(clip.end) - start);
  const take = Math.min(clip.duration, sourceSpan);
  return ['-ss', start.toFixed(3), '-t', take.toFixed(3), '-i', source.filePath];
}

/** Видеоцепочка одного клипа: нормализация → кадрирование → длительность. */
function videoChainForClip(segment, source, opts) {
  const { width, height, fps, fitMode, capabilities } = opts;
  const clip = segment.clip;
  const label = `v${segment.index}`;
  const parts = [];

  if (clip.type === 'photo' && capabilities.zoompan) {
    const frames = Math.max(2, Math.round(clip.duration * fps));
    const kb = kenBurnsExpressions(segment.index, frames);
    const canvasW = Math.round((width * KEN_BURNS_CANVAS) / 2) * 2;
    const canvasH = Math.round((height * KEN_BURNS_CANVAS) / 2) * 2;
    parts.push(
      `scale=${canvasW}:${canvasH}:force_original_aspect_ratio=increase:${SCALE_OPTS}`,
      `crop=${canvasW}:${canvasH}`,
      `zoompan=z='${kb.z}':x='${kb.x}':y='${kb.y}':d=1:s=${width}x${height}:fps=${fps}`,
    );
  } else {
    parts.push(fitChain(fitMode, width, height));
  }

  parts.push('setsar=1', `fps=${fps}`);

  // Исходник короче слота на таймлайне — держим последний кадр, иначе поедут
  // все последующие переходы.
  if (clip.type === 'video') {
    const span = Math.max(0.1, Number(clip.end) - Math.max(0, Number(clip.start) || 0));
    const shortfall = clip.duration - span;
    if (shortfall > 0.04) {
      parts.push(`tpad=stop_mode=clone:stop_duration=${shortfall.toFixed(3)}`);
    }
  }

  parts.push(`trim=duration=${clip.duration.toFixed(3)}`, 'format=yuv420p', 'setpts=PTS-STARTPTS');

  // Открывающее затемнение, если первый клип помечен переходом через чёрный.
  if (segment.index === 0 && canonicalTransition(clip.transition?.type) === 'fadeBlack') {
    const d = Math.min(0.5, clip.duration / 2);
    parts.splice(parts.length - 1, 0, `fade=t=in:st=0:d=${d.toFixed(3)}`);
  }

  return { label, filter: `[${segment.index}:v]${parts.join(',')}[${label}]` };
}

/**
 * Полная команда рендера.
 *
 * @param {{plan: object, timeline: object, sources: Map<string, object>,
 *          fitMode: string, capabilities: object, verifiedCatalog: object,
 *          subtitlePath: string|null, overlayPath: string|null,
 *          fontsDir: string|null, outputPath: string, preset?: string}} opts
 */
export function buildRenderCommand(opts) {
  const {
    plan,
    timeline,
    sources,
    fitMode,
    capabilities,
    verifiedCatalog,
    subtitlePath,
    overlayPath,
    fontsDir,
    outputPath,
    preset = 'medium',
  } = opts;

  const exp = plan.export;
  const { width, height, fps } = exp;
  const total = timeline.totalDuration;
  const notes = [...(timeline.notes ?? [])];

  const inputArgs = [];
  const filters = [];
  const videoLabels = [];

  // ── Входы и нормализация каждого клипа ──────────────────────────────────
  for (const segment of timeline.segments) {
    const source = sources.get(segment.clip.mediaId);
    inputArgs.push(...inputArgsForClip(segment, source, fps));

    const video = videoChainForClip(segment, source, { width, height, fps, fitMode, capabilities });
    filters.push(video.filter);
    videoLabels.push(video.label);
  }

  // ── Склейка видео: cut → concat, остальное → xfade с перекрытием ────────
  let videoAcc = videoLabels[0];
  for (let i = 1; i < timeline.segments.length; i += 1) {
    const segment = timeline.segments[i];
    const out = `vc${i}`;

    if (segment.overlap > 0) {
      const type = canonicalTransition(segment.transition);
      const available = verifiedCatalog?.byType ?? TRANSITION_CATALOG;
      let mode = TRANSITION_CATALOG[type]?.xfade ?? TRANSITION_CATALOG[FALLBACK_TRANSITION].xfade;

      // §2.2: тип вне проверенного каталога не роняет рендер.
      if (!Object.hasOwn(available, type)) {
        notes.push(`transition-fallback: ${type} недоступен в этой сборке, использовано растворение`);
        mode = TRANSITION_CATALOG[FALLBACK_TRANSITION].xfade;
      }

      filters.push(
        `[${videoAcc}][${videoLabels[i]}]xfade=transition=${mode}` +
          `:duration=${segment.overlap.toFixed(3)}:offset=${segment.start.toFixed(3)}[${out}]`,
      );
    } else {
      filters.push(`[${videoAcc}][${videoLabels[i]}]concat=n=2:v=1:a=0[${out}]`);
    }
    videoAcc = out;
  }

  // ── Субтитры и текстовые слои ───────────────────────────────────────────
  // Оба — .ass файлы. Пользовательский текст в командную строку не попадает.
  let videoOut = videoAcc;
  const burn = (assPath, label) => {
    if (!assPath) return;
    if (!capabilities.subtitles) {
      notes.push(`${label}-not-burned: сборка FFmpeg без libass`);
      return;
    }
    const args = [`filename=${escapeFilterPath(assPath)}`];
    if (fontsDir) args.push(`fontsdir=${escapeFilterPath(fontsDir)}`);
    filters.push(`[${videoOut}]subtitles=${args.join(':')}[${label}]`);
    videoOut = label;
  };

  burn(subtitlePath, 'vsub');
  burn(overlayPath, 'vtext');

  // ── Звук (§1 v2): оригинал либо ничего ──────────────────────────────────
  const audio = buildAudioGraph({
    segments: timeline.segments,
    sources,
    keepOriginal: plan.audio.keepOriginal,
    capabilities,
  });
  filters.push(...audio.filters);
  notes.push(...audio.notes);

  // ── Кодек и контейнер (§1 v1, §8 v2) ────────────────────────────────────
  const args = [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-progress',
    'pipe:1',
    '-nostats',
    ...inputArgs,
    '-filter_complex',
    filters.join(';'),
    '-map',
    `[${videoOut}]`,
  ];

  if (audio.enabled) {
    args.push('-map', `[${audio.outLabel}]`);
  } else {
    // Явный -an: без него FFmpeg может подтянуть дорожку первого входа.
    args.push('-an');
  }

  args.push(
    // Метаданные исходников не переносим: в них бывают геотеги и имена устройств.
    '-map_metadata',
    '-1',
    '-c:v',
    'libx264',
    '-preset',
    preset,
    '-profile:v',
    'high',
    '-level:v',
    levelToX264(exp.level),
    '-pix_fmt',
    'yuv420p',
    '-color_range',
    'tv',
    '-b:v',
    `${exp.videoBitrateKbps}k`,
    '-maxrate',
    `${exp.maxrateKbps}k`,
    '-bufsize',
    `${exp.maxrateKbps * 2}k`,
    '-g',
    String(fps * 2),
    '-keyint_min',
    String(fps),
    '-sc_threshold',
    '0',
    '-r',
    String(fps),
  );

  if (audio.enabled) {
    args.push('-c:a', 'aac', '-b:a', `${exp.audioBitrateKbps}k`, '-ar', '48000', '-ac', '2');
  }

  args.push(
    '-movflags',
    '+faststart',
    '-max_muxing_queue_size',
    '1024',
    '-t',
    total.toFixed(3),
    '-y',
    outputPath,
  );

  return {
    args,
    filterComplex: filters.join(';'),
    expectedDuration: total,
    hasAudio: audio.enabled,
    notes,
  };
}

/** Команда извлечения обложки 9:16 из готового ролика (§4.3 v1). */
export function buildThumbnailCommand({ videoPath, atSeconds, outputPath }) {
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-ss',
    Math.max(0, atSeconds).toFixed(3),
    '-i',
    videoPath,
    '-frames:v',
    '1',
    '-q:v',
    '3',
    '-y',
    outputPath,
  ];
}
