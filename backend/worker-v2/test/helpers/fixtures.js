// Общие фикстуры тестов: валидный plan.json и генерация синтетических
// исходников через FFmpeg (в репозитории не держим бинарные ассеты).

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

/** Корень репозитория — нужен тесту сверки с docs/render-contract.md. */
export const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');

export function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${bin} exited ${code}: ${stderr.slice(-800)}`)),
    );
  });
}

/** Есть ли рабочий FFmpeg — e2e-тесты без него пропускаются, а не падают. */
export async function ffmpegAvailable() {
  try {
    await run(FFMPEG, ['-hide_banner', '-version']);
    await run(FFPROBE, ['-hide_banner', '-version']);
    return true;
  } catch {
    return false;
  }
}

export async function tempDir(prefix = 'reelio-test-') {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Тестовое видео: цветные полосы + тон 440 Гц (имитация «речи» для ducking).
 * `silent: true` даёт дорожку тишины — так проверяется ветка без ducking.
 */
export async function makeVideo(filePath, opts = {}) {
  const {
    duration = 4,
    width = 640,
    height = 480,
    fps = 30,
    silent = false,
    noAudio = false,
  } = opts;

  await mkdir(path.dirname(filePath), { recursive: true });

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${width}x${height}:rate=${fps}:duration=${duration}`,
  ];

  if (!noAudio) {
    const audio = silent
      ? `anullsrc=channel_layout=stereo:sample_rate=48000:duration=${duration}`
      : `sine=frequency=440:sample_rate=48000:duration=${duration}`;
    args.push('-f', 'lavfi', '-i', audio);
  }

  args.push(
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-t',
    String(duration),
  );
  if (!noAudio) args.push('-c:a', 'aac', '-ac', '2', '-ar', '48000');
  args.push('-y', filePath);

  await run(FFMPEG, args);
  return filePath;
}

/**
 * Тестовое видео с метаданными поворота: в контейнере кадр горизонтальный,
 * а на экране должен быть вертикальным. Так снимают телефоны.
 */
export async function makeRotatedVideo(filePath, opts = {}) {
  const { rotation = 90, ...videoOpts } = opts;
  const flat = `${filePath}.flat.mp4`;
  await makeVideo(flat, videoOpts);
  await run(FFMPEG, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-display_rotation',
    String(rotation),
    '-i',
    flat,
    '-c',
    'copy',
    '-y',
    filePath,
  ]);
  return filePath;
}

/** Тестовое фото (JPEG) — для ветки pan/zoom. */
export async function makePhoto(filePath, opts = {}) {
  const { width = 800, height = 600 } = opts;
  await mkdir(path.dirname(filePath), { recursive: true });
  await run(FFMPEG, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${width}x${height}:rate=1:duration=1`,
    '-frames:v',
    '1',
    '-y',
    filePath,
  ]);
  return filePath;
}

/** Минимальный валидный plan.json (снимок RenderRequest). */
export function makePlanDocument(overrides = {}) {
  const base = {
    contractVersion: 2,
    jobId: 'job_TEST0001',
    projectId: 'proj_test',
    plan: {
      id: 'plan_test_1',
      prompt: 'тестовый ролик',
      style: 'dynamicStyle',
      durationSeconds: 8,
      captions: {
        enabled: true,
        language: 'ru',
        style: 'bold',
        colorHex: '#FFFFFF',
        fontId: 'montserrat',
        position: 'bottom',
        sampleText: 'Лучшие моменты поездки на море',
      },
      // §1 v2: музыки нет, есть переключатель оригинального звука.
      audio: { keepOriginal: true },
      textOverlays: [],
      coverClipId: 'clip_1',
      clips: [
        {
          id: 'clip_1',
          mediaId: 'asset_a',
          type: 'video',
          duration: 3,
          start: 0.5,
          end: 3.5,
          transition: { type: 'cut' },
          sourceName: 'IMG_0042.mp4',
          reason: 'самый динамичный фрагмент',
          filePath: '/local/should/be/ignored.mp4',
        },
        {
          id: 'clip_2',
          mediaId: 'asset_b',
          type: 'video',
          duration: 3,
          start: 0,
          end: 3,
          transition: { type: 'dissolve', durationSeconds: 0.45, intensity: 'balanced' },
        },
      ],
    },
    assets: [
      {
        id: 'asset_a',
        type: 'video',
        objectPath: 'projects/proj_test/sources/asset_a.mp4',
        sizeBytes: 12345,
        durationSeconds: 4,
        width: 640,
        height: 480,
      },
      {
        id: 'asset_b',
        type: 'video',
        objectPath: 'projects/proj_test/sources/asset_b.mp4',
        sizeBytes: 12345,
        durationSeconds: 4,
        width: 640,
        height: 480,
      },
    ],
    export: {
      resolution: 'hd720',
      width: 720,
      height: 1280,
      fps: 30,
      estimatedSizeBytes: 5_000_000,
      isUpscale: false,
    },
  };

  return deepMerge(base, overrides);
}

function deepMerge(target, source) {
  if (Array.isArray(source)) return source;
  if (!source || typeof source !== 'object') return source ?? target;
  const out = { ...target };
  for (const [key, value] of Object.entries(source)) {
    out[key] =
      value && typeof value === 'object' && !Array.isArray(value) && target?.[key]
        ? deepMerge(target[key], value)
        : value;
  }
  return out;
}

/**
 * План в форме v1: строковые переходы, поле `music`, без `audio` и
 * `textOverlays`. Используется тестами обратной совместимости (§0, §7).
 */
export function makeV1PlanDocument(overrides = {}) {
  const doc = makePlanDocument(overrides);
  doc.contractVersion = 1;

  doc.plan.music = { track: 'chill', volume: 0.7 };
  delete doc.plan.audio;
  delete doc.plan.textOverlays;
  delete doc.plan.captions.fontId;
  delete doc.plan.captions.position;

  // v1 знал только строковые переходы cut | fade | crossfade | slide.
  doc.plan.clips[0].transition = 'cut';
  doc.plan.clips[1].transition = 'crossfade';

  return doc;
}

/** Заглушка probe-результата для чистых тестов filtergraph. */
export function makeSource(overrides = {}) {
  return {
    assetId: 'asset_a',
    filePath: '/tmp/asset_a.mp4',
    width: 640,
    height: 480,
    rotation: 0,
    fps: 30,
    duration: 4,
    hasAudio: true,
    hasSpeech: true,
    ...overrides,
  };
}

/** Полный набор возможностей FFmpeg — «идеальная» сборка. */
/** Все режимы xfade, которые упоминает каталог §2.1. */
export const ALL_XFADE_MODES = new Set([
  'fade',
  'fadeblack',
  'fadewhite',
  'wipeleft',
  'wiperight',
  'wipeup',
  'wipedown',
  'slideleft',
  'slideright',
  'slideup',
  'slidedown',
  'smoothleft',
  'smoothright',
  'smoothup',
  'smoothdown',
  'circleopen',
  'circleclose',
  'zoomin',
  'pixelize',
  'radial',
  'hblur',
]);

export function fullCapabilities(overrides = {}) {
  return {
    version: 'ffmpeg version test',
    xfadeTransitions: new Set(ALL_XFADE_MODES),
    subtitles: true,
    drawtext: true,
    xfade: true,
    acrossfade: true,
    zoompan: true,
    sidechaincompress: true,
    loudnorm: true,
    alimiter: true,
    libx264: true,
    aac: true,
    ...overrides,
  };
}
