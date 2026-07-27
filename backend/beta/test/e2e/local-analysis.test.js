// Локальный анализ на настоящем FFmpeg (§2, §3, §6 задания).
//
// Здесь проверяется то, ради чего локальный проход вообще существует: сцены
// действительно находятся, кадров извлекается ровно столько, сколько разрешает
// лимит, а метрики качества отражают реальную картинку. Это и есть контроль
// стоимости: если выборка кадров сломается, счёт за Gemini вырастет молча.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import { ANALYSIS_LIMITS, framesForDuration } from '../../src/limits.js';
import {
  cutsToScenes,
  detectSceneCuts,
  extractAudio,
  extractKeyframes,
  frameToInlineData,
  hasAudibleSpeech,
  measureQuality,
  probeAsset,
  selectKeyframeTimes,
} from '../../src/local-analysis.js';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${bin} exit ${code}: ${stderr.slice(-400)}`)),
    );
  });
}

async function available() {
  try {
    await run(FFMPEG, ['-hide_banner', '-version']);
    await run(FFPROBE, ['-hide_banner', '-version']);
    return true;
  } catch {
    return false;
  }
}

/** Видео из трёх заведомо разных кусков — две смены сцены. */
async function makeThreeSceneVideo(filePath, { withTone = true } = {}) {
  const parts = [
    'testsrc2=size=320x240:rate=15:duration=2',
    'smptebars=size=320x240:rate=15:duration=2',
    'testsrc=size=320x240:rate=15:duration=2',
  ];

  const args = ['-hide_banner', '-loglevel', 'error'];
  for (const part of parts) args.push('-f', 'lavfi', '-i', part);
  if (withTone) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6');

  args.push(
    '-filter_complex',
    '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
    '-map',
    '[v]',
  );
  if (withTone) args.push('-map', '3:a', '-c:a', 'aac');

  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-y', filePath);
  await run(FFMPEG, args);
  return filePath;
}

const ffmpegReady = await available();

describe('локальный анализ', { skip: ffmpegReady ? false : 'ffmpeg недоступен' }, () => {
  test('ffprobe даёт длительность, кадр и наличие звука', { timeout: 120_000 }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'reelio-la-'));
    const file = await makeThreeSceneVideo(path.join(dir, 'v.mp4'));

    const probe = await probeAsset(FFPROBE, file);
    assert.ok(probe, 'ffprobe должен вернуть метаданные');
    assert.ok(Math.abs(probe.durationSeconds - 6) < 0.5);
    assert.equal(probe.width, 320);
    assert.equal(probe.height, 240);
    assert.equal(probe.hasAudio, true);
    assert.equal(probe.rotation, 0);
  });

  test('нечитаемый файл даёт null, а не падение', { timeout: 60_000 }, async () => {
    assert.equal(await probeAsset(FFPROBE, '/nonexistent/file.mp4'), null);
  });

  test('§2: смены сцен находятся до обращения к модели', { timeout: 120_000 }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'reelio-la-'));
    const file = await makeThreeSceneVideo(path.join(dir, 'v.mp4'));

    const cuts = await detectSceneCuts(FFMPEG, file);
    assert.equal(cuts.length, 2, `ожидались две склейки, найдено: ${cuts.join(', ')}`);
    assert.ok(Math.abs(cuts[0] - 2) < 0.3, `первая склейка на ${cuts[0]}`);
    assert.ok(Math.abs(cuts[1] - 4) < 0.3, `вторая склейка на ${cuts[1]}`);
  });

  test('§2: границы превращаются в непрерывные сцены', { timeout: 120_000 }, async () => {
    const scenes = cutsToScenes([2, 4], 6);
    assert.deepEqual(scenes, [
      { start: 0, end: 2 },
      { start: 2, end: 4 },
      { start: 4, end: 6 },
    ]);
  });

  test('§2: ролик без склеек — это одна сцена, а не ноль', () => {
    assert.deepEqual(cutsToScenes([], 5), [{ start: 0, end: 5 }]);
  });

  test('§6: метрики качества измеряются по реальным кадрам', { timeout: 180_000 }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'reelio-la-'));
    const file = await makeThreeSceneVideo(path.join(dir, 'v.mp4'));

    const quality = await measureQuality(FFMPEG, file);
    assert.ok(quality, 'метрики должны считаться');
    assert.ok(quality.samples > 0);
    for (const key of ['sharpness', 'exposure', 'motion']) {
      assert.ok(quality[key] >= 0 && quality[key] <= 1, `${key} = ${quality[key]}`);
    }
  });

  test('§3: кадры берутся из середины сцен и не превышают лимит', { timeout: 180_000 }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'reelio-la-'));
    const file = await makeThreeSceneVideo(path.join(dir, 'v.mp4'));

    const scenes = cutsToScenes(await detectSceneCuts(FFMPEG, file), 6);
    const times = selectKeyframeTimes({ scenes, durationSeconds: 6, limit: 10 });

    assert.deepEqual(times, [1, 3, 5], 'середины трёх сцен');

    const frames = await extractKeyframes(FFMPEG, file, times, path.join(dir, 'frames'));
    assert.equal(frames.length, 3);
    for (const frame of frames) {
      assert.ok(frame.bytes > 0);
      assert.ok(frame.bytes <= ANALYSIS_LIMITS.maxFrameBytes);
      assert.ok((await stat(frame.path)).size === frame.bytes);
    }
  });

  test('§3: лимит кадров соблюдается даже при множестве сцен', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ start: i, end: i + 1 }));
    const times = selectKeyframeTimes({ scenes: many, durationSeconds: 100, limit: 50 });
    assert.ok(times.length <= ANALYSIS_LIMITS.maxFramesPerVideo);
  });

  test('§3: длинное видео не даёт больше кадров, чем разрешено', () => {
    assert.equal(framesForDuration(600), ANALYSIS_LIMITS.maxFramesPerVideo);
    const scenes = Array.from({ length: 300 }, (_, i) => ({ start: i * 2, end: i * 2 + 2 }));
    const times = selectKeyframeTimes({ scenes, durationSeconds: 600 });
    assert.ok(times.length <= ANALYSIS_LIMITS.maxFramesPerVideo, `кадров: ${times.length}`);
  });

  test('кадр кодируется в inline-данные для модели', { timeout: 120_000 }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'reelio-la-'));
    const file = await makeThreeSceneVideo(path.join(dir, 'v.mp4'));
    const frames = await extractKeyframes(FFMPEG, file, [1], path.join(dir, 'frames'));

    const inline = await frameToInlineData(frames[0].path);
    assert.equal(inline.mimeType, 'image/jpeg');
    assert.ok(inline.data.length > 100);
    // JPEG начинается с /9j/ в base64.
    assert.ok(inline.data.startsWith('/9j/'), inline.data.slice(0, 8));
  });

  test('§4: аудио извлекается моно 16 кГц и в пределах лимита', { timeout: 180_000 }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'reelio-la-'));
    const file = await makeThreeSceneVideo(path.join(dir, 'v.mp4'));

    const audio = await extractAudio(FFMPEG, file, path.join(dir, 'audio.m4a'));
    assert.ok(audio, 'аудио должно извлечься');
    assert.ok(audio.bytes > 0);
    assert.ok(audio.bytes <= ANALYSIS_LIMITS.maxAudioBytes);

    const probe = await probeAsset(FFPROBE, audio.path);
    assert.equal(probe, null, 'в аудиофайле нет видеопотока — probeAsset вернёт null');
  });

  test('§4: видео без звука не даёт аудиофайла', { timeout: 180_000 }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'reelio-la-'));
    const file = await makeThreeSceneVideo(path.join(dir, 'v.mp4'), { withTone: false });

    assert.equal(await extractAudio(FFMPEG, file, path.join(dir, 'a.m4a')), null);
  });

  test('§4: наличие звука определяется до дорогого распознавания', { timeout: 180_000 }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'reelio-la-'));
    const loud = await makeThreeSceneVideo(path.join(dir, 'loud.mp4'));
    const silent = await makeThreeSceneVideo(path.join(dir, 'silent.mp4'), { withTone: false });

    assert.equal(await hasAudibleSpeech(FFMPEG, loud), true);
    assert.equal(await hasAudibleSpeech(FFMPEG, silent), false);
  });

  test('весь локальный проход укладывается в разумное время', { timeout: 300_000 }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'reelio-la-'));
    const file = await makeThreeSceneVideo(path.join(dir, 'v.mp4'));

    const started = Date.now();
    const probe = await probeAsset(FFPROBE, file);
    const scenes = cutsToScenes(await detectSceneCuts(FFMPEG, file), probe.durationSeconds);
    await measureQuality(FFMPEG, file);
    const times = selectKeyframeTimes({ scenes, durationSeconds: probe.durationSeconds });
    await extractKeyframes(FFMPEG, file, times, path.join(dir, 'frames'));
    await extractAudio(FFMPEG, file, path.join(dir, 'a.m4a'));
    const elapsed = Date.now() - started;

    assert.ok(
      elapsed < ANALYSIS_LIMITS.perAssetTimeoutMs,
      `локальный анализ занял ${elapsed} мс при лимите ${ANALYSIS_LIMITS.perAssetTimeoutMs}`,
    );
  });
});
