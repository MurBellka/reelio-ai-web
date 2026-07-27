#!/usr/bin/env node
// §17: проверка, что русский TextOverlay ФИЗИЧЕСКИ виден в кадрах готового MP4.
//
// Зачем отдельно от остальных тестов. Юнит-тесты доказывают, что мы правильно
// сформировали .ass: там есть нужный текст, координаты и стиль. Но между
// корректным .ass и видимой надписью стоит libass — и если его нет в сборке,
// если не найден шрифт, если кириллица отрисовалась «квадратиками», все
// юнит-тесты останутся зелёными, а пользователь получит ролик без подписи.
// Поэтому здесь мы смотрим на пиксели.
//
// Метод. Рендерим три ролика с одинаковыми исходниками:
//   A — без текста (эталон фона);
//   B — с русским текстом;
//   C — с латинским текстом той же длины.
// Затем сравниваем кадры в яркостном (gray) представлении:
//   1) B заметно отличается от A внутри полосы, где стоит текст → надпись есть;
//   2) вне этой полосы B почти не отличается от A → это именно надпись,
//      а не общий сдвиг картинки;
//   3) B отличается от C → кириллица отрисована СВОИМИ глифами, а не
//      одинаковыми «квадратиками» отсутствующего шрифта.
//
// Запуск (в контейнере с libass):
//   node tools/verify-text-visible.mjs

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { detectCapabilities } from '../src/ffmpeg.js';
import { buildRenderCommand } from '../src/filtergraph.js';
import { overlaysToAss } from '../src/textoverlay.js';
import { buildTimeline } from '../src/timeline.js';
import { buildVerifiedCatalog } from '../src/transitions.js';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FONTS_DIR = process.env.REELIO_FONTS_DIR || '/opt/reelio/fonts';

const WIDTH = 360;
const HEIGHT = 640;
const FPS = 25;
const CLIP_SECONDS = 2;
/** Момент, в котором надпись точно на экране. */
const PROBE_AT = 1.0;

const RUSSIAN_TEXT = 'ПРИВЕТ МИР';
const LATIN_TEXT = 'PRIVET MIR';

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

/** Кадр в момент t как массив яркостей — без декодера PNG, сырые байты. */
async function grayFrame(videoPath, atSeconds) {
  const raw = await run(
    FFMPEG,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      atSeconds.toFixed(3),
      '-i',
      videoPath,
      '-frames:v',
      '1',
      '-pix_fmt',
      'gray',
      '-f',
      'rawvideo',
      '-',
    ],
    { capture: true },
  );

  if (raw.length !== WIDTH * HEIGHT) {
    throw new Error(`неожиданный размер кадра: ${raw.length}, ожидалось ${WIDTH * HEIGHT}`);
  }
  return raw;
}

/** Доля пикселей, различающихся сильнее порога, в указанной полосе строк. */
function diffRatio(a, b, { fromRow, toRow, threshold = 40 }) {
  let differing = 0;
  let total = 0;

  for (let y = fromRow; y < toRow; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const i = y * WIDTH + x;
      total += 1;
      if (Math.abs(a[i] - b[i]) > threshold) differing += 1;
    }
  }
  return total === 0 ? 0 : differing / total;
}

/** Рендерит ролик; overlays === null означает «без текста». */
async function render(outputPath, workDir, overlays) {
  const clips = [
    {
      id: 'c1',
      mediaId: 'a',
      type: 'video',
      duration: CLIP_SECONDS,
      start: 0,
      end: CLIP_SECONDS,
      transition: { type: 'cut', durationSeconds: null, intensity: 'balanced' },
    },
  ];

  let overlayPath = null;
  if (overlays) {
    overlayPath = path.join(workDir, `${path.basename(outputPath, '.mp4')}.ass`);
    await writeFile(overlayPath, overlaysToAss(overlays, { width: WIDTH, height: HEIGHT }), 'utf8');
  }

  const capabilities = await detectCapabilities(FFMPEG);
  if (!capabilities.subtitles) {
    throw new Error(
      'сборка FFmpeg без libass — вшить текст невозможно, проверка бессмысленна.\n' +
        'Запускайте этот скрипт в образе worker-v2 (см. Dockerfile.verify).',
    );
  }

  const command = buildRenderCommand({
    plan: {
      audio: { keepOriginal: false },
      export: {
        resolution: 'hd720',
        width: WIDTH,
        height: HEIGHT,
        fps: FPS,
        videoBitrateKbps: 2000,
        maxrateKbps: 2500,
        audioBitrateKbps: 128,
        level: '4.0',
        preset: null,
      },
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

function makeOverlay(text) {
  return [
    {
      id: 'probe',
      text,
      start: 0,
      end: CLIP_SECONDS,
      clipId: null,
      anchor: 'center',
      x: 0.5,
      y: 0.5,
      requestedX: 0.5,
      requestedY: 0.5,
      insideSafeZone: true,
      fontId: 'montserrat',
      fontFamily: 'Montserrat',
      fontWeight: 'bold',
      fontSizeRatio: 0.09,
      colorHex: '#FFFFFF',
      align: 'center',
      opacity: 1,
      background: null,
      // Обводка даёт контраст на любом фоне — иначе белый текст на светлом
      // кадре и правда был бы почти невиден, и проверка ловила бы не то.
      outline: { colorHex: '#000000', widthRatio: 0.008 },
      shadow: null,
      animation: 'none',
      maxLineChars: 24,
    },
  ];
}

async function main() {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'reelio-text-verify-'));
  const results = [];

  try {
    // Ровный тёмно-серый фон: на нём белая надпись даёт максимальный контраст,
    // а отсутствие движения исключает ложные различия между рендерами.
    await run(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=c=0x202020:size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=${CLIP_SECONDS}`,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-y',
      path.join(workDir, 'src.mp4'),
    ]);

    const plain = path.join(workDir, 'plain.mp4');
    const russian = path.join(workDir, 'russian.mp4');
    const latin = path.join(workDir, 'latin.mp4');

    const command = await render(plain, workDir, null);
    await render(russian, workDir, makeOverlay(RUSSIAN_TEXT));
    await render(latin, workDir, makeOverlay(LATIN_TEXT));

    if (command.notes.some((n) => n.includes('not-burned'))) {
      throw new Error('текст не был вшит: worker сообщил о деградации');
    }

    const [framePlain, frameRu, frameLat] = await Promise.all([
      grayFrame(plain, PROBE_AT),
      grayFrame(russian, PROBE_AT),
      grayFrame(latin, PROBE_AT),
    ]);

    // Полоса, где стоит надпись: центр ±10% высоты.
    const band = { fromRow: Math.round(HEIGHT * 0.4), toRow: Math.round(HEIGHT * 0.6) };
    const outsideTop = { fromRow: 0, toRow: Math.round(HEIGHT * 0.3) };

    const inkInBand = diffRatio(framePlain, frameRu, band);
    const inkOutside = diffRatio(framePlain, frameRu, outsideTop);
    const cyrillicVsLatin = diffRatio(frameRu, frameLat, band);

    results.push(
      ['надпись видна в своей полосе', inkInBand, (v) => v > 0.01, `${(inkInBand * 100).toFixed(2)}% пикселей`],
      ['вне полосы кадр не изменился', inkOutside, (v) => v < 0.002, `${(inkOutside * 100).toFixed(2)}% пикселей`],
      [
        'кириллица отрисована своими глифами',
        cyrillicVsLatin,
        (v) => v > 0.003,
        `${(cyrillicVsLatin * 100).toFixed(2)}% отличий от латиницы`,
      ],
    );

    let failed = 0;
    console.log('Проверка видимости русского текста в кадрах\n');
    for (const [name, value, ok, detail] of results) {
      const passed = ok(value);
      if (!passed) failed += 1;
      console.log(`  ${passed ? '✔' : '✖'} ${name.padEnd(42)} ${detail}`);
    }

    console.log(
      `\nШрифты: ${FONTS_DIR}\nТекст: «${RUSSIAN_TEXT}»\nКадр: ${WIDTH}×${HEIGHT}, момент ${PROBE_AT} с`,
    );

    if (failed > 0) {
      console.error(`\nПРОВАЛЕНО проверок: ${failed}`);
      process.exitCode = 1;
    } else {
      console.log('\nВсе проверки пройдены: русский текст физически присутствует в кадре.');
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`Ошибка: ${err.message}`);
  process.exitCode = 1;
});
