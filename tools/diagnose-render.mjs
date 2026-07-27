#!/usr/bin/env node
// Диагностика расхождений рендера между сборками FFmpeg.
//
// Нужен, когда тесты worker'а зелёные на одной машине и красные на другой:
// сообщение «Готовый ролик не прошёл проверку» само по себе не говорит, ЧТО
// именно разошлось. Скрипт повторяет минимальный сценарий (два коротких клипа
// с плавным переходом), прогоняет проверку и печатает список расхождений
// вместе с фактическими характеристиками файла.
//
// Ничего не меняет и никуда не деплоит — только читает модули worker'а.
//
//   node tools/diagnose-render.mjs backend/worker
//   node tools/diagnose-render.mjs backend/worker-v2

import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const workerDir = path.resolve(process.argv[2] ?? 'backend/worker');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

const load = (file) => import(pathToFileURL(path.join(workerDir, 'src', file)).href);

function run(bin, args, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', capture ? 'pipe' : 'ignore', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout?.on('data', (c) => {
      out += c;
    });
    child.stderr.on('data', (c) => {
      err += c;
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${bin} exit ${code}: ${err.slice(-800)}`)),
    );
  });
}

/** Синтетический клип: разные источники, чтобы переход был заметен. */
async function makeClip(file, source, seconds) {
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `${source}=size=320x240:rate=30:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ac', '2', '-ar', '48000',
    '-t', String(seconds), '-y', file,
  ]);
  return file;
}

async function main() {
  console.log(`worker: ${workerDir}`);
  console.log((await run(FFMPEG, ['-hide_banner', '-version'], true)).split('\n')[0]);

  const { detectCapabilities, runFfmpeg } = await load('ffmpeg.js');
  const { buildRenderCommand } = await load('filtergraph.js');
  const { buildTimeline } = await load('timeline.js');
  const { verifyOutput } = await load('probe.js');

  const capabilities = await detectCapabilities(FFMPEG);
  console.log(
    `возможности: subtitles=${capabilities.subtitles} zoompan=${capabilities.zoompan} ` +
      `loudnorm=${capabilities.loudnorm} alimiter=${capabilities.alimiter}`,
  );

  const dir = await mkdtemp(path.join(os.tmpdir(), 'reelio-diag-'));
  const a = await makeClip(path.join(dir, 'a.mp4'), 'testsrc2', 1);
  const b = await makeClip(path.join(dir, 'b.mp4'), 'smptebars', 1);

  // v1 и v2 описывают переход по-разному: строкой против объекта.
  const isV2 = workerDir.endsWith('worker-v2');
  const transition = (type) => (isV2 ? { type, durationSeconds: null, intensity: 'balanced' } : type);

  const clips = [
    { id: 'c1', mediaId: 'a', type: 'video', duration: 1, start: 0, end: 1, transition: transition('cut') },
    {
      id: 'c2', mediaId: 'b', type: 'video', duration: 1, start: 0, end: 1,
      transition: transition(isV2 ? 'dissolve' : 'crossfade'),
    },
  ];

  const timeline = buildTimeline(clips);
  const outputPath = path.join(dir, 'out.mp4');

  const plan = {
    export: {
      resolution: 'hd720', width: 720, height: 1280, fps: 30,
      videoBitrateKbps: 4000, maxrateKbps: 5000, audioBitrateKbps: 128,
      level: '4.0', preset: null,
    },
    clips,
    ...(isV2 ? { audio: { keepOriginal: true } } : { music: { track: 'none', volume: 0 } }),
  };

  const sources = new Map([
    ['a', { filePath: a, hasAudio: true, hasSpeech: true, width: 320, height: 240 }],
    ['b', { filePath: b, hasAudio: true, hasSpeech: true, width: 320, height: 240 }],
  ]);

  const command = buildRenderCommand({
    plan, timeline, sources,
    fitMode: 'cover', capabilities,
    ...(isV2 ? { verifiedCatalog: undefined, overlayPath: null } : { musicInput: null, hasSpeech: true }),
    subtitlePath: null, fontsDir: null,
    outputPath, preset: 'ultrafast',
  });

  console.log(`ожидаемая длительность: ${command.expectedDuration}`);
  for (const note of command.notes) console.log(`  примечание: ${note}`);

  await runFfmpeg(FFMPEG, command.args);

  const verification = await verifyOutput(FFPROBE, outputPath, {
    width: 720, height: 1280, fps: 30,
    durationSeconds: command.expectedDuration,
    ...(isV2 ? { hasAudio: command.hasAudio } : {}),
  });

  console.log(`\nфактически: ${JSON.stringify(verification.info)}`);
  if (verification.ok) {
    console.log('\nПРОВЕРКА ПРОЙДЕНА');
  } else {
    console.log('\nРАСХОЖДЕНИЯ:');
    for (const problem of verification.problems) console.log(`  • ${problem}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`Ошибка: ${err.message}`);
  process.exitCode = 1;
});
