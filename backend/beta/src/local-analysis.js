// Локальный анализ материала до обращения к Gemini (§2, §3, §6 задания).
//
// Порядок принципиален: сначала ffprobe и FFmpeg меряют то, что измеримо
// бесплатно и точно — длительность, кадр, поворот, границы сцен, резкость,
// экспозицию, движение, наличие звука. И только потом, по уже сокращённой
// выборке кадров, спрашиваем модель о том, чего FFmpeg не знает: где главный
// объект, какие фрагменты удачные, что говорят.
//
// Это не оптимизация ради красоты, а способ управлять стоимостью: в Gemini
// уходит десяток кадров вместо тысяч и две минуты аудио вместо всего ролика.

import { spawn } from 'node:child_process';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { ANALYSIS_LIMITS, framesForDuration } from './limits.js';

/** Порог смены сцены для `select='gt(scene,X)'`. Подобран под монтажный контент. */
export const SCENE_THRESHOLD = 0.3;

/** Запускает процесс и собирает stdout/stderr. Ошибку возвращает, а не бросает. */
function run(bin, args, { timeoutMs = ANALYSIS_LIMITS.perAssetTimeoutMs, signal } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const onAbort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code: -1, stdout, stderr: String(err.message), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** ffprobe → метаданные материала. */
export async function probeAsset(ffprobePath, filePath, opts = {}) {
  const { code, stdout } = await run(
    ffprobePath,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    opts,
  );
  if (code !== 0) return null;

  let probe;
  try {
    probe = JSON.parse(stdout);
  } catch {
    return null;
  }

  const video = (probe.streams ?? []).find((s) => s.codec_type === 'video');
  const audio = (probe.streams ?? []).find((s) => s.codec_type === 'audio');
  if (!video) return null;

  // Поворот из display matrix: кадр телефона в контейнере часто «горизонтален».
  let rotation = 0;
  for (const side of video.side_data_list ?? []) {
    if (Number.isFinite(Number(side?.rotation))) {
      rotation = ((Math.round(Number(side.rotation)) % 360) + 360) % 360;
      break;
    }
  }
  const swapped = rotation === 90 || rotation === 270;

  const [num, den] = String(video.avg_frame_rate ?? video.r_frame_rate ?? '')
    .split('/')
    .map(Number);

  return {
    durationSeconds: Number(probe.format?.duration) || Number(video.duration) || 0,
    width: swapped ? Number(video.height) : Number(video.width),
    height: swapped ? Number(video.width) : Number(video.height),
    rotation,
    fps: Number.isFinite(num) && Number.isFinite(den) && den > 0 ? num / den : null,
    videoCodec: video.codec_name ?? null,
    hasAudio: Boolean(audio),
    audioCodec: audio?.codec_name ?? null,
    sizeBytes: Number(probe.format?.size) || null,
  };
}

/**
 * Границы сцен через `select='gt(scene,X)'`.
 *
 * Фильтр печатает метаданные только для кадров, где картинка сменилась, —
 * поэтому проход дешёвый даже на длинном видео.
 *
 * @returns {Promise<number[]>} моменты смены сцены в секундах
 */
export async function detectSceneCuts(ffmpegPath, filePath, opts = {}) {
  const threshold = opts.threshold ?? SCENE_THRESHOLD;
  const { code, stdout, stderr } = await run(
    ffmpegPath,
    [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      '-i',
      filePath,
      '-vf',
      `select='gt(scene,${threshold})',metadata=print:file=-`,
      '-an',
      '-f',
      'null',
      '-',
    ],
    opts,
  );
  if (code !== 0) return [];

  const cuts = [];
  for (const match of `${stdout}${stderr}`.matchAll(/pts_time:([\d.]+)/g)) {
    const seconds = Number(match[1]);
    if (Number.isFinite(seconds)) cuts.push(Number(seconds.toFixed(3)));
  }
  return [...new Set(cuts)].sort((a, b) => a - b);
}

/**
 * Границы сцен → отрезки. Всегда возвращает хотя бы одну сцену: ролик без
 * склеек — это одна сцена, а не ноль.
 */
export function cutsToScenes(cuts, durationSeconds) {
  const bounds = [0, ...cuts.filter((c) => c > 0.05 && c < durationSeconds - 0.05), durationSeconds];
  const scenes = [];
  for (let i = 0; i < bounds.length - 1; i += 1) {
    const start = bounds[i];
    const end = bounds[i + 1];
    if (end - start >= 0.2) {
      scenes.push({ start: Number(start.toFixed(3)), end: Number(end.toFixed(3)) });
    }
  }
  return scenes.length > 0
    ? scenes
    : [{ start: 0, end: Number(Math.max(durationSeconds, 0.2).toFixed(3)) }];
}

/**
 * Резкость, экспозиция и движение — измеряются, а не спрашиваются у модели.
 *
 * Проход идёт по одному кадру в секунду: этого достаточно для оценки и на
 * порядок дешевле полного декодирования.
 */
export async function measureQuality(ffmpegPath, filePath, opts = {}) {
  const { code, stdout, stderr } = await run(
    ffmpegPath,
    [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      '-i',
      filePath,
      '-vf',
      'fps=1,blurdetect,signalstats,metadata=print:file=-',
      '-an',
      '-f',
      'null',
      '-',
    ],
    opts,
  );
  if (code !== 0) return null;

  const text = `${stdout}${stderr}`;
  const blur = [...text.matchAll(/lavfi\.blur=([\d.]+)/g)].map((m) => Number(m[1]));
  const luma = [...text.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map((m) => Number(m[1]));
  const lumaDiff = [...text.matchAll(/lavfi\.signalstats\.YDIF=([\d.]+)/g)].map((m) => Number(m[1]));

  const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

  const blurMean = mean(blur);
  const lumaMean = mean(luma);
  const diffMean = mean(lumaDiff);

  return {
    // blurdetect: больше — размытее. 0..~10 на практике.
    sharpness: blurMean === null ? null : Number(Math.max(0, 1 - blurMean / 6).toFixed(3)),
    // Экспозиция: идеал — середина диапазона 0..255, края штрафуем.
    exposure:
      lumaMean === null ? null : Number((1 - Math.abs(lumaMean - 128) / 128).toFixed(3)),
    // YDIF — межкадровая разница: чем выше, тем активнее движение.
    motion: diffMean === null ? null : Number(Math.min(1, diffMean / 30).toFixed(3)),
    samples: blur.length,
  };
}

/**
 * Какие моменты снимать кадрами (§3).
 *
 * Берём середину каждой сцены — там картинка устоялась, в отличие от границы,
 * где может быть смаз перехода. Если сцен больше лимита, оставляем самые
 * длинные: короткие врезки для понимания материала менее полезны.
 *
 * Чистая функция — проверяется тестами без FFmpeg.
 */
export function selectKeyframeTimes({ scenes, durationSeconds, limit }) {
  const cap = Math.min(limit ?? framesForDuration(durationSeconds), ANALYSIS_LIMITS.maxFramesPerVideo);
  if (cap <= 0) return [];

  const usable = (scenes ?? []).filter((s) => s.end > s.start);
  if (usable.length === 0) {
    return [Number(Math.max(0, Math.min(durationSeconds / 2, durationSeconds - 0.05)).toFixed(3))];
  }

  const ranked = [...usable]
    .map((scene, index) => ({ ...scene, index, length: scene.end - scene.start }))
    .sort((a, b) => b.length - a.length)
    .slice(0, cap)
    .sort((a, b) => a.index - b.index);

  return ranked.map((scene) =>
    Number(Math.max(0, Math.min((scene.start + scene.end) / 2, durationSeconds - 0.05)).toFixed(3)),
  );
}

/**
 * Извлекает кадры в JPEG. Кадры уменьшаются до 768 по длинной стороне: модель
 * всё равно работает с таким размером, а платим мы за пиксели.
 *
 * @returns {Promise<{atSeconds: number, path: string, bytes: number}[]>}
 */
export async function extractKeyframes(ffmpegPath, filePath, times, outDir, opts = {}) {
  await mkdir(outDir, { recursive: true });
  const frames = [];

  for (const [i, atSeconds] of times.entries()) {
    const framePath = path.join(outDir, `frame_${String(i).padStart(2, '0')}.jpg`);
    const { code } = await run(
      ffmpegPath,
      [
        '-hide_banner',
        '-nostdin',
        '-loglevel',
        'error',
        '-ss',
        atSeconds.toFixed(3),
        '-i',
        filePath,
        '-frames:v',
        '1',
        '-vf',
        "scale='min(768,iw)':'min(768,ih)':force_original_aspect_ratio=decrease",
        '-q:v',
        '4',
        '-y',
        framePath,
      ],
      opts,
    );
    if (code !== 0) continue;

    const { size } = await stat(framePath).catch(() => ({ size: 0 }));
    if (size === 0) continue;
    // Слишком тяжёлый кадр не отправляем: это прямые деньги за токены.
    if (size > ANALYSIS_LIMITS.maxFrameBytes) continue;

    frames.push({ atSeconds, path: framePath, bytes: size });
  }

  return frames;
}

/**
 * Извлекает аудио для распознавания речи (§4).
 *
 * Моно 16 кГц — стандарт для ASR: стерео и 48 кГц не улучшают распознавание,
 * но увеличивают размер и стоимость.
 */
export async function extractAudio(ffmpegPath, filePath, outPath, opts = {}) {
  const maxSeconds = Math.min(
    opts.maxSeconds ?? ANALYSIS_LIMITS.maxAudioSecondsPerVideo,
    ANALYSIS_LIMITS.maxAudioSecondsPerVideo,
  );

  await mkdir(path.dirname(outPath), { recursive: true });
  const { code } = await run(
    ffmpegPath,
    [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      '-i',
      filePath,
      '-vn',
      '-t',
      String(maxSeconds),
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'aac',
      '-b:a',
      '64k',
      '-y',
      outPath,
    ],
    opts,
  );
  if (code !== 0) return null;

  const { size } = await stat(outPath).catch(() => ({ size: 0 }));
  if (size === 0 || size > ANALYSIS_LIMITS.maxAudioBytes) return null;

  return { path: outPath, bytes: size, seconds: maxSeconds };
}

/** Есть ли в дорожке звук громче порога тишины — дешёвая проверка до ASR. */
export async function hasAudibleSpeech(ffmpegPath, filePath, opts = {}) {
  const { code, stderr } = await run(
    ffmpegPath,
    [
      '-hide_banner',
      '-nostdin',
      '-i',
      filePath,
      '-vn',
      '-t',
      String(opts.seconds ?? 60),
      '-af',
      'volumedetect',
      '-f',
      'null',
      '-',
    ],
    opts,
  );
  if (code !== 0) return false;

  const match = /mean_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(stderr);
  return match ? Number(match[1]) > -50 : false;
}

/** Кадр в base64 для inline-передачи в Gemini. */
export async function frameToInlineData(framePath) {
  const buffer = await readFile(framePath);
  return { mimeType: 'image/jpeg', data: buffer.toString('base64') };
}
