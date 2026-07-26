// Сборка командной строки FFmpeg: входы, filter_complex, параметры кодека.
//
// Модуль намеренно чистый — никакого ввода-вывода. На вход идут план, таймлайн
// и результаты ffprobe, на выход — массив аргументов. Благодаря этому весь
// монтаж (кадрирование, переходы, ducking, субтитры) проверяется тестами без
// запуска FFmpeg, а e2e-тест остаётся тонкой проверкой «оно и правда собирает
// валидный MP4».

import { XFADE_BY_TRANSITION, levelToX264 } from './contract.js';

/** Ducking по §2: параметры компрессора зафиксированы контрактом. */
export const DUCKING = {
  threshold: 0.05,
  ratio: 8,
  attackMs: 20,
  releaseMs: 300,
  /** Целевой уровень музыки под речью: music.volume × 0.35 (§2). */
  duckedLevelFactor: 0.35,
};

/** Целевая громкость мастера, LUFS. -16 — безопасно для соцсетей. */
export const LOUDNESS_TARGET_LUFS = -16;

/** Насколько канва под zoompan больше кадра (запас на приближение). */
const KEN_BURNS_CANVAS = 1.4;
const KEN_BURNS_MAX_ZOOM = 1.18;

/**
 * Экранирование пути внутри аргумента фильтра: FFmpeg трактует «:» как
 * разделитель опций, а «,» и «;» — как границы фильтров.
 */
export function escapeFilterPath(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/([,;[\]])/g, '\\$1');
}

/**
 * Опции scale, общие для всех цепочек.
 *
 * `out_range=tv` обязателен: JPEG и другие фотоисточники приходят в полном
 * диапазоне (pc), и без явного приведения libx264 пометит поток как yuvj420p —
 * а §1 требует ровно yuv420p. Для видео, которое и так в tv-диапазоне, это
 * ничего не меняет.
 */
const SCALE_OPTS = 'flags=bicubic:in_range=auto:out_range=tv';

/** Цепочка вписывания кадра в 9:16 — всегда с сохранением пропорций. */
export function fitChain(fitMode, width, height) {
  if (fitMode === 'contain') {
    // Контрактный вариант §1: масштаб + pad до точного кадра.
    return [
      `scale=${width}:${height}:force_original_aspect_ratio=decrease:${SCALE_OPTS}`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    ].join(',');
  }
  // cover: масштаб «в накрытие» + центральный кроп. Растяжения нет — лишнее
  // обрезается. Это поведение по умолчанию для вертикальных роликов.
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

  if (variant === 0) {
    return { z: `1+${amp}*on/${n}`, x: center.x, y: center.y, name: 'zoom-in' };
  }
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
 * включён по умолчанию, а его синтаксис несовместим между версиями — в
 * FFmpeg ≤ 6 опция требовала значение (`-autorotate 1`), в 7+ это флаг без
 * аргумента, и лишний «1» уезжает в имя выходного файла. Нормализация
 * поворота обеспечивается двумя вещами: декодер применяет display matrix к
 * пикселям, а probe.displayDimensions() даёт уже развёрнутые размеры, по
 * которым принимается решение о кадрировании. В результат метаданные поворота
 * не попадают — их снимает `-map_metadata -1`.
 */
function inputArgsForClip(segment, source, fps) {
  const clip = segment.clip;
  if (clip.type === 'photo') {
    // Фото разворачивается в клип нужной длины прямо на входе.
    return ['-loop', '1', '-framerate', String(fps), '-t', clip.duration.toFixed(3), '-i', source.filePath];
  }

  const start = Math.max(0, Number(clip.start) || 0);
  const sourceSpan = Math.max(0.1, Number(clip.end) - start);
  // Берём не больше, чем нужно на таймлайне: остаток всё равно будет обрезан.
  const take = Math.min(clip.duration, sourceSpan);
  // -ss перед -i — быстрый поиск по ключевым кадрам с точной доводкой.
  return ['-ss', start.toFixed(3), '-t', take.toFixed(3), '-i', source.filePath];
}

/** Видеоцепочка одного клипа: нормализация → кадрирование → длительность. */
function videoChainForClip(segment, source, opts) {
  const { width, height, fps, fitMode } = opts;
  const clip = segment.clip;
  const label = `v${segment.index}`;
  const input = `${segment.index}:v`;
  const parts = [];

  if (clip.type === 'photo' && opts.capabilities.zoompan) {
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

  // Исходник короче, чем слот на таймлайне, — держим последний кадр, чтобы не
  // поехали все последующие переходы.
  if (clip.type === 'video') {
    const span = Math.max(0.1, Number(clip.end) - Math.max(0, Number(clip.start) || 0));
    const shortfall = clip.duration - span;
    if (shortfall > 0.04) {
      parts.push(`tpad=stop_mode=clone:stop_duration=${shortfall.toFixed(3)}`);
    }
  }

  parts.push(`trim=duration=${clip.duration.toFixed(3)}`, 'format=yuv420p', 'setpts=PTS-STARTPTS');

  // Открывающее затемнение, если первый клип помечен переходом fade.
  if (segment.index === 0 && clip.transition === 'fade') {
    const d = Math.min(0.5, clip.duration / 2);
    parts.splice(parts.length - 1, 0, `fade=t=in:st=0:d=${d.toFixed(3)}`);
  }

  return { label, filter: `[${input}]${parts.join(',')}[${label}]` };
}

/** Аудиоцепочка клипа: реальная дорожка либо тишина ровно на длину клипа. */
function audioChainForClip(segment, source) {
  const clip = segment.clip;
  const label = `a${segment.index}`;
  const d = clip.duration.toFixed(3);

  if (clip.type === 'video' && source.hasAudio) {
    const parts = [
      'aresample=48000:async=1:first_pts=0',
      'aformat=sample_fmts=fltp:channel_layouts=stereo',
      `apad=whole_dur=${d}`,
      `atrim=0:${d}`,
      'asetpts=PTS-STARTPTS',
    ];
    return { label, filter: `[${segment.index}:a]${parts.join(',')}[${label}]` };
  }

  // Фото и видео без звука: тишина, иначе конкатенация развалится.
  return {
    label,
    filter:
      `anullsrc=channel_layout=stereo:sample_rate=48000,` +
      `atrim=0:${d},asetpts=PTS-STARTPTS[${label}]`,
  };
}

/**
 * Полная команда рендера.
 *
 * @param {{
 *   plan: object,
 *   timeline: {segments: object[], totalDuration: number},
 *   sources: Map<string, object>,
 *   fitMode: string,
 *   capabilities: object,
 *   subtitlePath: string|null,
 *   fontsDir: string|null,
 *   musicInput: {inputArgs: string[], label: string}|null,
 *   hasSpeech: boolean,
 *   outputPath: string,
 *   preset?: string,
 * }} opts
 */
export function buildRenderCommand(opts) {
  const {
    plan,
    timeline,
    sources,
    fitMode,
    capabilities,
    subtitlePath,
    fontsDir,
    musicInput,
    hasSpeech,
    outputPath,
    preset = 'medium',
  } = opts;

  const exp = plan.export;
  const { width, height, fps } = exp;
  const total = timeline.totalDuration;
  const notes = [];

  const inputArgs = [];
  const filters = [];

  // ── Входы и нормализация каждого клипа ──────────────────────────────────
  const videoLabels = [];
  const audioLabels = [];

  for (const segment of timeline.segments) {
    const source = sources.get(segment.clip.mediaId);
    inputArgs.push(...inputArgsForClip(segment, source, fps));

    const video = videoChainForClip(segment, source, { width, height, fps, fitMode, capabilities });
    filters.push(video.filter);
    videoLabels.push(video.label);

    const audio = audioChainForClip(segment, source);
    filters.push(audio.filter);
    audioLabels.push(audio.label);
  }

  if (musicInput) {
    inputArgs.push(...musicInput.inputArgs);
  }
  const musicInputIndex = musicInput ? timeline.segments.length : -1;

  // ── Склейка видео: cut → concat, остальное → xfade с перекрытием ────────
  let videoAcc = videoLabels[0];
  for (let i = 1; i < timeline.segments.length; i += 1) {
    const segment = timeline.segments[i];
    const next = videoLabels[i];
    const out = `vc${i}`;

    if (segment.overlap > 0) {
      let mode = XFADE_BY_TRANSITION[segment.transition] ?? 'fade';
      // Старые сборки FFmpeg знают не все режимы (zoomin появился позже
      // slideleft). Вместо падения откатываемся на растворение.
      const known = capabilities.xfadeTransitions;
      if (known?.size > 0 && !known.has(mode)) {
        notes.push(`xfade-fallback: ${mode} unavailable, using fade`);
        mode = 'fade';
      }
      filters.push(
        `[${videoAcc}][${next}]xfade=transition=${mode}:duration=${segment.overlap.toFixed(3)}` +
          `:offset=${segment.start.toFixed(3)}[${out}]`,
      );
    } else {
      filters.push(`[${videoAcc}][${next}]concat=n=2:v=1:a=0[${out}]`);
    }
    videoAcc = out;
  }

  // ── Склейка звука зеркалит видео, иначе разъедутся тайминги ─────────────
  let audioAcc = audioLabels[0];
  for (let i = 1; i < timeline.segments.length; i += 1) {
    const segment = timeline.segments[i];
    const next = audioLabels[i];
    const out = `ac${i}`;

    if (segment.overlap > 0 && capabilities.acrossfade) {
      filters.push(
        `[${audioAcc}][${next}]acrossfade=d=${segment.overlap.toFixed(3)}:c1=tri:c2=tri[${out}]`,
      );
    } else {
      filters.push(`[${audioAcc}][${next}]concat=n=2:v=0:a=1[${out}]`);
    }
    audioAcc = out;
  }

  // ── Субтитры ────────────────────────────────────────────────────────────
  let videoOut = videoAcc;
  if (subtitlePath) {
    if (capabilities.subtitles) {
      const args = [`filename=${escapeFilterPath(subtitlePath)}`];
      if (fontsDir) args.push(`fontsdir=${escapeFilterPath(fontsDir)}`);
      filters.push(`[${videoOut}]subtitles=${args.join(':')}[vsub]`);
      videoOut = 'vsub';
    } else {
      // Без libass впечатать текст нечем; SRT/ASS всё равно выгружаются рядом
      // с роликом, поэтому субтитры не теряются — только не вшиты в кадр.
      notes.push('subtitles-not-burned: ffmpeg build has no libass');
    }
  }

  // ── Звуковой тракт: нормализация речи → ducking музыки → лимитер ────────
  let voiceLabel = audioAcc;

  if (hasSpeech && capabilities.loudnorm) {
    filters.push(`[${voiceLabel}]loudnorm=I=${LOUDNESS_TARGET_LUFS}:TP=-1.5:LRA=11[vo]`);
    voiceLabel = 'vo';
  } else if (hasSpeech) {
    notes.push('loudnorm-unavailable: speech left unnormalized');
  }

  let mixLabel = voiceLabel;

  if (musicInput) {
    const musicParts = [
      'aresample=48000',
      'aformat=sample_fmts=fltp:channel_layouts=stereo',
      `apad=whole_dur=${total.toFixed(3)}`,
      `atrim=0:${total.toFixed(3)}`,
      'asetpts=PTS-STARTPTS',
      `volume=${plan.music.volume.toFixed(3)}`,
    ];
    filters.push(`[${musicInputIndex}:a]${musicParts.join(',')}[mus]`);

    if (hasSpeech && capabilities.sidechaincompress) {
      // §2: музыка приглушается компрессором с боковой цепью, где сайдчейн —
      // сама речь. Копию голоса даёт asplit: один экземпляр идёт в микс,
      // второй управляет компрессором.
      filters.push(`[${voiceLabel}]asplit=2[voice_main][voice_sc]`);
      filters.push(
        `[mus][voice_sc]sidechaincompress=threshold=${DUCKING.threshold}:ratio=${DUCKING.ratio}` +
          `:attack=${DUCKING.attackMs}:release=${DUCKING.releaseMs}:level_sc=1[mus_duck]`,
      );
      filters.push(
        '[voice_main][mus_duck]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mix]',
      );
    } else {
      if (hasSpeech) notes.push('ducking-unavailable: no sidechaincompress filter');
      filters.push(
        `[${voiceLabel}][mus]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mix]`,
      );
    }
    mixLabel = 'mix';
  }

  const finalAudioParts = [];
  if (capabilities.alimiter) {
    // Сумма речи и музыки может выйти за 0 dBFS — лимитер спасает от клиппинга.
    finalAudioParts.push('alimiter=limit=0.95:level=disabled');
  }
  finalAudioParts.push('aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo');
  filters.push(`[${mixLabel}]${finalAudioParts.join(',')}[aout]`);

  // ── Кодек и контейнер (§1) ──────────────────────────────────────────────
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
    '-map',
    '[aout]',
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
    // Без явного tv-диапазона поток из фотоисточников тегируется как yuvj420p.
    '-color_range',
    'tv',
    '-b:v',
    `${exp.videoBitrateKbps}k`,
    '-maxrate',
    `${exp.maxrateKbps}k`,
    '-bufsize',
    `${exp.maxrateKbps * 2}k`,
    // GOP = 2 × fps (§1); закрытый ключевой интервал без сцен-детекции даёт
    // предсказуемый размер и ровную перемотку в ленте.
    '-g',
    String(fps * 2),
    '-keyint_min',
    String(fps),
    '-sc_threshold',
    '0',
    '-r',
    String(fps),
    '-c:a',
    'aac',
    '-b:a',
    `${exp.audioBitrateKbps}k`,
    '-ar',
    '48000',
    '-ac',
    '2',
    '-movflags',
    '+faststart',
    '-max_muxing_queue_size',
    '1024',
    '-t',
    total.toFixed(3),
    '-y',
    outputPath,
  ];

  return { args, filterComplex: filters.join(';'), expectedDuration: total, notes };
}

/** Команда извлечения обложки 9:16 из готового ролика (§4.3). */
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
