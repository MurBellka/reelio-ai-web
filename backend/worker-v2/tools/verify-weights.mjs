#!/usr/bin/env node
// Проверка, что НАЧЕРТАНИЕ (regular/medium/bold) реально доходит до MP4.
//
// Зачем отдельно. Юнит-тесты доказывают, что resolveFont отдаёт правильное имя
// семейства для каждого веса. Но увидеть Medium в кадре можно только прогнав
// настоящий рендер через libass: если fontconfig не проиндексировал
// «Montserrat Medium» или ASS-строка собрана неверно, medium молча выйдет
// как Regular — и все юнит-тесты останутся зелёными.
//
// Метод. Для одного семейства с настоящим Medium (Montserrat) рендерим три
// одинаковых ролика, меняя только вес. Затем в яркостном кадре меряем:
//   • «чернил» (доля светлых пикселей белого текста в полосе) — растёт с весом;
//   • попарные различия кадров.
// Утверждаем:
//   1) все три веса видны;
//   2) medium ОТЛИЧАЕТСЯ от regular — значит вес не подменён Regular'ом;
//   3) bold отличается от medium;
//   4) bold «жирнее» regular (чернил больше) — монотонность по весу.
//
// Запуск (в контейнере с libass):
//   node tools/verify-weights.mjs

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { detectCapabilities } from '../src/ffmpeg.js';
import { buildRenderCommand } from '../src/filtergraph.js';
import { resolveFont } from '../src/fonts.js';
import { overlaysToAss } from '../src/textoverlay.js';
import { buildTimeline } from '../src/timeline.js';
import { buildVerifiedCatalog } from '../src/transitions.js';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FONTS_DIR = process.env.REELIO_FONTS_DIR || '/usr/share/fonts/truetype/reelio';

const WIDTH = 360;
const HEIGHT = 640;
const FPS = 25;
const CLIP_SECONDS = 2;
const PROBE_AT = 1.0;

const FONT_ID = 'montserrat'; // у него есть настоящий Medium
const TEXT = 'ВЕС Weight';

function run(bin, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', capture ? 'pipe' : 'ignore', 'pipe'] });
    const chunks = [];
    let stderr = '';
    child.stdout?.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks))
        : reject(new Error(`${bin} exit ${code}: ${stderr.slice(-600)}`)),
    );
  });
}

async function grayFrame(videoPath, atSeconds) {
  const raw = await run(
    FFMPEG,
    ['-hide_banner', '-loglevel', 'error', '-ss', atSeconds.toFixed(3), '-i', videoPath,
      '-frames:v', '1', '-pix_fmt', 'gray', '-f', 'rawvideo', '-'],
    { capture: true },
  );
  if (raw.length !== WIDTH * HEIGHT) {
    throw new Error(`неожиданный размер кадра: ${raw.length}, ожидалось ${WIDTH * HEIGHT}`);
  }
  return raw;
}

const BAND = { fromRow: Math.round(HEIGHT * 0.35), toRow: Math.round(HEIGHT * 0.65) };

/** Доля светлых пикселей (белый текст) в полосе — «количество чернил». */
function inkRatio(frame, threshold = 128) {
  let bright = 0;
  let total = 0;
  for (let y = BAND.fromRow; y < BAND.toRow; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      total += 1;
      if (frame[y * WIDTH + x] > threshold) bright += 1;
    }
  }
  return total === 0 ? 0 : bright / total;
}

/** Доля пикселей полосы, различающихся сильнее порога. */
function diffRatio(a, b, threshold = 40) {
  let differing = 0;
  let total = 0;
  for (let y = BAND.fromRow; y < BAND.toRow; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const i = y * WIDTH + x;
      total += 1;
      if (Math.abs(a[i] - b[i]) > threshold) differing += 1;
    }
  }
  return total === 0 ? 0 : differing / total;
}

function overlayForWeight(weight) {
  const font = resolveFont(FONT_ID, weight);
  return [
    {
      id: `w-${weight}`,
      text: TEXT,
      start: 0,
      end: CLIP_SECONDS,
      clipId: null,
      anchor: 'center',
      x: 0.5,
      y: 0.5,
      requestedX: 0.5,
      requestedY: 0.5,
      insideSafeZone: true,
      fontId: font.fontId,
      // Имя семейства берём из resolveFont — именно его чинили: для medium это
      // «Montserrat Medium», иначе libass взял бы Regular.
      fontFamily: font.family,
      fontWeight: weight,
      fontSizeRatio: 0.1,
      colorHex: '#FFFFFF',
      align: 'center',
      opacity: 1,
      background: null,
      // Без обводки — чтобы толстая чёрная рамка не маскировала разницу штрихов.
      outline: null,
      shadow: null,
      animation: 'none',
      maxLineChars: 24,
    },
  ];
}

async function render(outputPath, workDir, overlays, capabilities) {
  const clips = [
    { id: 'c1', mediaId: 'a', type: 'video', duration: CLIP_SECONDS, start: 0, end: CLIP_SECONDS,
      transition: { type: 'cut', durationSeconds: null, intensity: 'balanced' } },
  ];
  const overlayPath = path.join(workDir, `${path.basename(outputPath, '.mp4')}.ass`);
  await writeFile(overlayPath, overlaysToAss(overlays, { width: WIDTH, height: HEIGHT }), 'utf8');

  const command = buildRenderCommand({
    plan: {
      audio: { keepOriginal: false },
      export: { resolution: 'hd720', width: WIDTH, height: HEIGHT, fps: FPS,
        videoBitrateKbps: 2000, maxrateKbps: 2500, audioBitrateKbps: 128, level: '4.0', preset: null },
      clips,
    },
    timeline: buildTimeline(clips),
    sources: new Map([['a', { filePath: path.join(workDir, 'src.mp4'), hasAudio: false }]]),
    fitMode: 'cover',
    capabilities,
    verifiedCatalog: buildVerifiedCatalog(capabilities.xfadeTransitions),
    subtitlePath: null,
    overlayPath,
    fontsDir: FONTS_DIR,
    outputPath,
    preset: 'ultrafast',
  });
  await run(FFMPEG, command.args);
  return command;
}

async function main() {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'reelio-weights-'));
  try {
    const capabilities = await detectCapabilities(FFMPEG);
    if (!capabilities.subtitles) {
      throw new Error(
        'сборка FFmpeg без libass — вес в кадр не вшить.\n' +
          'Запускайте в образе worker-v2 (см. Dockerfile.verify).',
      );
    }

    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
      `color=c=0x202020:size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=${CLIP_SECONDS}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-y',
      path.join(workDir, 'src.mp4')]);

    const frames = {};
    for (const weight of ['regular', 'medium', 'bold']) {
      const out = path.join(workDir, `${weight}.mp4`);
      const command = await render(out, workDir, overlayForWeight(weight), capabilities);
      if (command.notes.some((n) => n.includes('not-burned'))) {
        throw new Error(`вес ${weight}: текст не вшит — worker сообщил о деградации`);
      }
      frames[weight] = await grayFrame(out, PROBE_AT);
    }

    const inkR = inkRatio(frames.regular);
    const inkM = inkRatio(frames.medium);
    const inkB = inkRatio(frames.bold);
    const dMR = diffRatio(frames.medium, frames.regular);
    const dBM = diffRatio(frames.bold, frames.medium);

    const checks = [
      ['regular виден', inkR, (v) => v > 0.003, `${(inkR * 100).toFixed(2)}% чернил`],
      ['medium виден', inkM, (v) => v > 0.003, `${(inkM * 100).toFixed(2)}% чернил`],
      ['bold виден', inkB, (v) => v > 0.003, `${(inkB * 100).toFixed(2)}% чернил`],
      ['medium ОТЛИЧАЕТСЯ от regular (вес не подменён)', dMR, (v) => v > 0.002,
        `${(dMR * 100).toFixed(2)}% различий`],
      ['bold отличается от medium', dBM, (v) => v > 0.002, `${(dBM * 100).toFixed(2)}% различий`],
      ['bold жирнее regular', inkB - inkR, (v) => v > 0, `Δчернил ${((inkB - inkR) * 100).toFixed(2)}%`],
    ];

    console.log(`Проверка веса в экспорте (шрифт ${FONT_ID}, текст «${TEXT}»)\n`);
    let failed = 0;
    for (const [name, value, ok, detail] of checks) {
      const passed = ok(value);
      if (!passed) failed += 1;
      console.log(`  ${passed ? '✔' : '✖'} ${name.padEnd(46)} ${detail}`);
    }
    console.log(`\nСемейства ASS: regular=«${resolveFont(FONT_ID, 'regular').family}», ` +
      `medium=«${resolveFont(FONT_ID, 'medium').family}», bold=«${resolveFont(FONT_ID, 'bold').family}»`);

    if (failed > 0) {
      console.error(`\nПРОВАЛЕНО проверок: ${failed}`);
      process.exitCode = 1;
    } else {
      console.log('\nВсе проверки пройдены: regular, medium и bold доходят до MP4 как разные начертания.');
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`Ошибка: ${err.message}`);
  process.exitCode = 1;
});
