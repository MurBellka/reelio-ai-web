// End-to-end v2: plan.json → настоящий MP4, собранный настоящим FFmpeg.
//
// Работает в local mode (§10 v1): хранилище — каталог, канал прогресса (§8.1) —
// HTTP-сервер на 127.0.0.1. Никаких облачных ресурсов и обращений наружу.

import assert from 'node:assert/strict';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { PHASES } from '../../src/contract.js';
import { loadEnv } from '../../src/env.js';
import { hasFastStart, runFfprobe } from '../../src/ffmpeg.js';
import { Logger } from '../../src/logger.js';
import { rotationOf, verifyOutput } from '../../src/probe.js';
import { ProgressReporter } from '../../src/progress.js';
import { runRender } from '../../src/render.js';
import { createStorage } from '../../src/storage.js';
import {
  FFPROBE,
  ffmpegAvailable,
  makePhoto,
  makePlanDocument,
  makeRotatedVideo,
  makeV1PlanDocument,
  makeVideo,
  tempDir,
} from '../helpers/fixtures.js';

const PROJECT_ID = 'proj_e2e';
const JOB_ID = 'job_e2e0001';
const PREFIX = `projects/${PROJECT_ID}/`;

/** Фейковый backend §8.1: собирает отчёты и умеет попросить отмену. */
async function startProgressServer(options = {}) {
  const reports = [];
  const cancelAfter = options.cancelAfter ?? Infinity;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      reports.push({ ...JSON.parse(body || '{}'), authorization: req.headers.authorization });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ ok: true, cancelRequested: reports.length >= cancelAfter, status: 'running' }),
      );
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    reports,
    url: `http://127.0.0.1:${server.address().port}/internal/jobs/${JOB_ID}/progress`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Готовит local-хранилище с исходниками и планом. */
async function setupJob(planOverrides = {}, opts = {}) {
  const root = await tempDir('reelio-v2-');
  const sourcesDir = path.join(root, `${PREFIX}sources`);
  await mkdir(sourcesDir, { recursive: true });

  await makeVideo(path.join(sourcesDir, 'asset_a.mp4'), {
    duration: 4,
    width: 640,
    height: 480,
    ...(opts.a ?? {}),
  });
  await makeVideo(path.join(sourcesDir, 'asset_b.mp4'), {
    duration: 4,
    width: 480,
    height: 640,
    ...(opts.b ?? {}),
  });

  const document = (opts.v1 ? makeV1PlanDocument : makePlanDocument)({
    jobId: JOB_ID,
    projectId: PROJECT_ID,
    ...planOverrides,
  });
  for (const asset of document.assets) {
    asset.objectPath = `${PREFIX}sources/${asset.id}.mp4`;
  }

  const planPath = path.join(root, `${PREFIX}jobs/${JOB_ID}/plan.json`);
  await mkdir(path.dirname(planPath), { recursive: true });
  await writeFile(planPath, JSON.stringify(document, null, 2));

  return { root, document, planPath };
}

function makeEnv(root, progressUrl, extra = {}) {
  return loadEnv({
    REELIO_JOB_ID: JOB_ID,
    REELIO_PROJECT_ID: PROJECT_ID,
    REELIO_PROJECT_PREFIX: PREFIX,
    REELIO_JOB_PREFIX: `${PREFIX}jobs/${JOB_ID}/`,
    REELIO_PLAN_URI: `file://${root}/${PREFIX}jobs/${JOB_ID}/plan.json`,
    REELIO_OUTPUT_PREFIX: `${PREFIX}jobs/${JOB_ID}/output`,
    REELIO_PROGRESS_URL: progressUrl,
    REELIO_WORKER_TOKEN: 'e2e-worker-token-value',
    REELIO_CONTRACT_VERSION: '2',
    REELIO_X264_PRESET: 'ultrafast',
    REELIO_LOG_LEVEL: 'debug',
    REELIO_WORK_DIR: path.join(root, 'work'),
    ...extra,
  });
}

const silentLogger = () => new Logger({ level: 'info', sink: () => {} });

function makeReporter(env, logger) {
  return new ProgressReporter({
    url: env.progressUrl,
    token: env.workerToken,
    jobId: env.jobId,
    logger,
    heartbeatMs: env.heartbeatMs,
  });
}

async function render(root, progressUrl, envExtra = {}) {
  const env = makeEnv(root, progressUrl, envExtra);
  const logger = silentLogger();
  const outcome = await runRender({
    env,
    storage: createStorage(env),
    reporter: makeReporter(env, logger),
    logger,
  });
  return { env, ...outcome };
}

const available = await ffmpegAvailable();

describe('e2e рендер v2', { skip: available ? false : 'ffmpeg/ffprobe недоступны' }, () => {
  let server;

  before(async () => {
    server = await startProgressServer();
  });
  after(async () => {
    await server?.close();
  });

  // ── Звук: два обязательных сценария ─────────────────────────────────────

  test('keepOriginal: true — MP4 с оригинальной речью и звуком', { timeout: 300_000 }, async () => {
    const { root } = await setupJob({ plan: { audio: { keepOriginal: true } } });
    const { result } = await render(root, server.url);

    assert.equal(result.hasAudio, true);
    assert.equal(result.audioCodec, 'aac');

    const videoPath = path.join(root, result.objectPath);
    const verification = await verifyOutput(FFPROBE, videoPath, {
      width: 720,
      height: 1280,
      fps: 30,
      durationSeconds: result.durationSeconds,
      hasAudio: true,
    });
    assert.deepEqual(verification.problems, []);
    assert.equal(verification.info.hasAudio, true);
    assert.equal(await hasFastStart(videoPath), true);
  });

  test('keepOriginal: false — MP4 полностью без звука', { timeout: 300_000 }, async () => {
    const { root } = await setupJob({ plan: { audio: { keepOriginal: false } } });
    const { result } = await render(root, server.url);

    assert.equal(result.hasAudio, false);
    assert.equal(result.audioCodec, null);

    const videoPath = path.join(root, result.objectPath);
    const probe = await runFfprobe(FFPROBE, videoPath);
    const audioStreams = probe.streams.filter((s) => s.codec_type === 'audio');
    assert.equal(audioStreams.length, 0, 'в контейнере не должно быть ни одной аудиодорожки');

    const verification = await verifyOutput(FFPROBE, videoPath, {
      width: 720,
      height: 1280,
      fps: 30,
      durationSeconds: result.durationSeconds,
      hasAudio: false,
    });
    assert.deepEqual(verification.problems, []);
    assert.equal(await hasFastStart(videoPath), true);
  });

  test('ролик из немых материалов экспортируется без дорожки', { timeout: 300_000 }, async () => {
    const { root } = await setupJob({}, { a: { noAudio: true }, b: { noAudio: true } });
    const { result } = await render(root, server.url);

    assert.equal(result.hasAudio, false);
    const probe = await runFfprobe(FFPROBE, path.join(root, result.objectPath));
    assert.equal(probe.streams.filter((s) => s.codec_type === 'audio').length, 0);
  });

  test('склейка звука сохраняет длительность и синхрон', { timeout: 300_000 }, async () => {
    const { root } = await setupJob();
    const { result } = await render(root, server.url);

    const probe = await runFfprobe(FFPROBE, path.join(root, result.objectPath));
    const video = probe.streams.find((s) => s.codec_type === 'video');
    const audio = probe.streams.find((s) => s.codec_type === 'audio');

    const videoDuration = Number(video.duration ?? probe.format.duration);
    const audioDuration = Number(audio.duration ?? probe.format.duration);
    assert.ok(
      Math.abs(videoDuration - audioDuration) < 0.25,
      `дорожки разъехались: видео ${videoDuration}, звук ${audioDuration}`,
    );
  });

  // ── Полный сценарий ─────────────────────────────────────────────────────

  test(
    'видео + фото + речь + переходы + текст + субтитры',
    { timeout: 600_000 },
    async () => {
      const { root } = await setupJob();
      await makePhoto(path.join(root, `${PREFIX}sources/asset_c.jpg`), { width: 900, height: 700 });

      const planPath = path.join(root, `${PREFIX}jobs/${JOB_ID}/plan.json`);
      const document = JSON.parse(await readFile(planPath, 'utf8'));

      document.assets.push({
        id: 'asset_c',
        type: 'photo',
        objectPath: `${PREFIX}sources/asset_c.jpg`,
        width: 900,
        height: 700,
      });
      document.plan.clips = [
        { id: 'clip_1', mediaId: 'asset_a', type: 'video', duration: 2.5, start: 0, end: 2.5, transition: { type: 'cut' } },
        {
          id: 'clip_2',
          mediaId: 'asset_c',
          type: 'photo',
          duration: 2,
          transition: { type: 'circleOpen', durationSeconds: 0.4 },
        },
        {
          id: 'clip_3',
          mediaId: 'asset_b',
          type: 'video',
          duration: 2.5,
          start: 0,
          end: 2.5,
          transition: { type: 'slideLeft', intensity: 'dynamic' },
        },
      ];
      document.plan.captions = {
        enabled: true,
        language: 'ru',
        style: 'karaoke',
        colorHex: '#FFFFFF',
        highlightColorHex: '#A855F7',
        fontId: 'montserrat',
        position: 'bottom',
        cues: [
          {
            start: 0.4,
            end: 2.2,
            text: 'Мы приехали на море',
            words: [
              { start: 0.4, end: 0.8, text: 'Мы', highlight: false },
              { start: 0.8, end: 1.5, text: 'приехали', highlight: true },
            ],
          },
          { start: 3.0, end: 5.0, text: 'Это было незабываемо!' },
        ],
      };
      document.plan.textOverlays = [
        {
          id: 'title',
          text: 'Наша поездка',
          startSeconds: 0.3,
          endSeconds: 2.4,
          position: { anchor: 'top' },
          fontId: 'montserrat',
          fontWeight: 'bold',
          colorHex: '#FFFFFF',
          outline: { colorHex: '#000000', widthRatio: 0.005 },
          animation: 'fade',
        },
        {
          id: 'cta',
          text: 'Подпишись, чтобы не пропустить: 50% «скидка»!',
          clipId: 'clip_3',
          startSeconds: 0.2,
          endSeconds: 2.3,
          position: { anchor: 'center' },
          fontId: 'caveat',
          background: { colorHex: '#000000', opacity: 0.5, paddingRatio: 0.02 },
          animation: 'pop',
        },
      ];
      await writeFile(planPath, JSON.stringify(document));

      server.reports.length = 0;
      const { result } = await render(root, server.url);

      // ── Ролик валиден ─────────────────────────────────────────────────
      const videoPath = path.join(root, result.objectPath);
      const verification = await verifyOutput(FFPROBE, videoPath, {
        width: 720,
        height: 1280,
        fps: 30,
        durationSeconds: result.durationSeconds,
        hasAudio: true,
      });
      assert.deepEqual(verification.problems, []);
      assert.equal(await hasFastStart(videoPath), true);

      // ── Обложка и субтитры выгружены ──────────────────────────────────
      assert.ok((await stat(path.join(root, result.thumbnailObjectPath))).size > 0);
      const srt = await readFile(path.join(root, `${PREFIX}jobs/${JOB_ID}/output/captions.srt`), 'utf8');
      assert.match(srt, /Мы приехали на море/);
      assert.match(srt, /Это было незабываемо!/);

      // ── Фазы прогресса пришли по порядку ──────────────────────────────
      const order = Object.keys(PHASES);
      let seen = -1;
      for (const report of server.reports) {
        const index = order.indexOf(report.phase);
        assert.ok(index >= seen, `фаза ${report.phase} пришла после более поздней`);
        seen = index;
      }
      for (const phase of ['preparing', 'downloading', 'rendering', 'encoding', 'uploading']) {
        assert.ok(server.reports.some((r) => r.phase === phase), `не было фазы ${phase}`);
      }
    },
  );

  // ── Совместимость и разрешения ──────────────────────────────────────────

  test('план v1 рендерится worker\'ом v2 без изменений', { timeout: 300_000 }, async () => {
    const { root } = await setupJob({}, { v1: true });
    const { result } = await render(root, server.url);

    assert.equal(result.planVersion, 1);
    assert.equal(result.contractVersion, 2);
    // v1 не знал переключателя звука — по умолчанию оригинал сохраняется.
    assert.equal(result.hasAudio, true);

    const verification = await verifyOutput(FFPROBE, path.join(root, result.objectPath), {
      width: 720,
      height: 1280,
      fps: 30,
      durationSeconds: result.durationSeconds,
      hasAudio: true,
    });
    assert.deepEqual(verification.problems, []);
  });

  test('пресет Instagram Reels даёт 1080×1920 при 30 кадрах', { timeout: 300_000 }, async () => {
    const { root } = await setupJob({ export: { preset: 'instagramReels' } });
    const { result } = await render(root, server.url);

    assert.equal(result.width, 1080);
    assert.equal(result.height, 1920);
    assert.equal(result.fps, 30);
    assert.equal(result.exportPreset, 'instagramReels');
    assert.ok(result.objectPath.endsWith('reel_1920p.mp4'));

    const verification = await verifyOutput(FFPROBE, path.join(root, result.objectPath), {
      width: 1080,
      height: 1920,
      fps: 30,
      durationSeconds: result.durationSeconds,
      hasAudio: true,
    });
    assert.deepEqual(verification.problems, []);
  });

  test('все четыре разрешения §1 собираются с текстом', { timeout: 900_000 }, async () => {
    const expected = {
      hd720: [720, 1280],
      fullHd1080: [1080, 1920],
      twoK1440: [1440, 2560],
      fourK2160: [2160, 3840],
    };

    for (const [resolution, [width, height]] of Object.entries(expected)) {
      const { root } = await setupJob({
        export: { resolution, fps: 30 },
        plan: {
          clips: [
            { id: 'clip_1', mediaId: 'asset_a', type: 'video', duration: 1, start: 0, end: 1, transition: { type: 'cut' } },
            { id: 'clip_2', mediaId: 'asset_b', type: 'video', duration: 1, start: 0, end: 1, transition: { type: 'dissolve' } },
          ],
          textOverlays: [
            { id: 't', text: 'Проверка', startSeconds: 0.1, endSeconds: 1.5, position: { anchor: 'center' } },
          ],
        },
      });

      const { result } = await render(root, server.url);
      assert.equal(result.width, width, resolution);
      assert.equal(result.height, height, resolution);

      const verification = await verifyOutput(FFPROBE, path.join(root, result.objectPath), {
        width,
        height,
        fps: 30,
        durationSeconds: result.durationSeconds,
        hasAudio: true,
      });
      assert.deepEqual(verification.problems, [], resolution);
    }
  });

  // ── Устойчивость ────────────────────────────────────────────────────────

  test('видео с метаданными поворота нормализуется', { timeout: 300_000 }, async () => {
    const { root } = await setupJob();
    await makeRotatedVideo(path.join(root, `${PREFIX}sources/asset_a.mp4`), {
      duration: 4,
      width: 640,
      height: 480,
      rotation: 90,
    });

    const { result } = await render(root, server.url);
    const videoPath = path.join(root, result.objectPath);

    const probe = await runFfprobe(FFPROBE, videoPath);
    const video = probe.streams.find((s) => s.codec_type === 'video');
    assert.equal(rotationOf(video), 0, 'в результате не должно остаться поворота');
  });

  test('русский текст со спецсимволами не ломает рендер', { timeout: 300_000 }, async () => {
    const { root } = await setupJob({
      plan: {
        textOverlays: [
          {
            id: 'nasty',
            // Двоеточия, запятые, кавычки, скобки и обратный слэш — всё, чем
            // можно было бы попробовать сломать filter_complex.
            text: String.raw`Цена: 1 000 ₽, скидка [50%] — «выгодно»; a'b\c{d}`,
            startSeconds: 0.2,
            endSeconds: 3,
            position: { anchor: 'center' },
          },
        ],
      },
    });

    const { result } = await render(root, server.url);
    const verification = await verifyOutput(FFPROBE, path.join(root, result.objectPath), {
      width: 720,
      height: 1280,
      fps: 30,
      durationSeconds: result.durationSeconds,
      hasAudio: true,
    });
    assert.deepEqual(verification.problems, []);
  });

  test('текст за безопасной зоной сдвигается, а не портит экспорт', { timeout: 300_000 }, async () => {
    const { root } = await setupJob({
      plan: {
        textOverlays: [
          { id: 'low', text: 'Под кнопками', startSeconds: 0.2, endSeconds: 3, position: { x: 0.5, y: 0.98 } },
        ],
      },
    });

    const { result } = await render(root, server.url);
    assert.ok(result.sizeBytes > 1000, 'ролик должен собраться');
  });

  test('отмена останавливает рендер и убирает временные файлы', { timeout: 300_000 }, async () => {
    const { root } = await setupJob();
    const cancelServer = await startProgressServer({ cancelAfter: 2 });
    try {
      await assert.rejects(
        () => render(root, cancelServer.url),
        (err) => {
          assert.equal(err.code, 'CANCELLED_BY_USER');
          return true;
        },
      );
      await assert.rejects(() => access(path.join(root, `${PREFIX}jobs/${JOB_ID}/output/reel_1280p.mp4`)));
      await assert.rejects(() => access(path.join(root, 'work')));
    } finally {
      await cancelServer.close();
    }
  });

  test('повреждённый исходник даёт SOURCE_UNREADABLE без утечки путей', { timeout: 300_000 }, async () => {
    const { root } = await setupJob();
    await writeFile(path.join(root, `${PREFIX}sources/asset_a.mp4`), 'не видео');

    await assert.rejects(
      () => render(root, server.url),
      (err) => {
        assert.equal(err.code, 'SOURCE_UNREADABLE');
        assert.ok(!err.message.includes(root));
        assert.ok(!err.message.includes('ffprobe'));
        return true;
      },
    );
  });
});
