// End-to-end: plan.json → настоящий MP4, собранный настоящим FFmpeg.
//
// Работает в local mode (§10): хранилище — каталог, канал прогресса (§8.1) —
// HTTP-сервер на 127.0.0.1. Никаких облачных ресурсов и сетевых вызовов наружу.

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
  makeVideo,
  tempDir,
} from '../helpers/fixtures.js';

const PROJECT_ID = 'proj_e2e';
const JOB_ID = 'job_e2e0001';

/**
 * Фейковый backend §8.1: собирает отчёты и умеет попросить отмену.
 * Слушает только петлевой интерфейс.
 */
async function startProgressServer(options = {}) {
  const reports = [];
  let cancelAfter = options.cancelAfter ?? Infinity;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      reports.push({ ...parsed, authorization: req.headers.authorization });
      const cancelRequested = reports.length >= cancelAfter;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, cancelRequested, status: 'running' }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    reports,
    url: `http://127.0.0.1:${port}/internal/jobs/${JOB_ID}/progress`,
    setCancelAfter(n) {
      cancelAfter = n;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Готовит local-хранилище с исходниками и планом. */
async function setupJob(planOverrides = {}, sourceOptions = {}) {
  const root = await tempDir('reelio-e2e-');
  const sourcesDir = path.join(root, `projects/${PROJECT_ID}/sources`);
  await mkdir(sourcesDir, { recursive: true });

  await makeVideo(path.join(sourcesDir, 'asset_a.mp4'), {
    duration: 4,
    width: 640,
    height: 480,
    ...(sourceOptions.a ?? {}),
  });
  await makeVideo(path.join(sourcesDir, 'asset_b.mp4'), {
    duration: 4,
    width: 480,
    height: 640,
    silent: true,
    ...(sourceOptions.b ?? {}),
  });

  const document = makePlanDocument({
    jobId: JOB_ID,
    projectId: PROJECT_ID,
    ...planOverrides,
  });
  // Пути исходников зависят от projectId — правим их под этот прогон.
  for (const asset of document.assets) {
    asset.objectPath = `projects/${PROJECT_ID}/sources/${asset.id}.mp4`;
  }

  const planPath = path.join(root, `projects/${PROJECT_ID}/jobs/${JOB_ID}/plan.json`);
  await mkdir(path.dirname(planPath), { recursive: true });
  await writeFile(planPath, JSON.stringify(document, null, 2));

  return { root, document, planPath };
}

function makeEnv(root, progressUrl, extra = {}) {
  return loadEnv({
    REELIO_JOB_ID: JOB_ID,
    REELIO_PROJECT_ID: PROJECT_ID,
    REELIO_PLAN_URI: `file://${root}/projects/${PROJECT_ID}/jobs/${JOB_ID}/plan.json`,
    REELIO_OUTPUT_PREFIX: `projects/${PROJECT_ID}/jobs/${JOB_ID}/output`,
    REELIO_PROGRESS_URL: progressUrl,
    REELIO_WORKER_TOKEN: 'e2e-worker-token-value',
    REELIO_CONTRACT_VERSION: '1',
    REELIO_X264_PRESET: 'ultrafast',
    REELIO_LOG_LEVEL: 'debug',
    // Явный рабочий каталог, чтобы тест мог проверить, что его убрали.
    REELIO_WORK_DIR: path.join(root, 'work'),
    ...extra,
  });
}

function makeReporter(env, logger) {
  return new ProgressReporter({
    url: env.progressUrl,
    token: env.workerToken,
    jobId: env.jobId,
    logger,
    heartbeatMs: env.heartbeatMs,
  });
}

const available = await ffmpegAvailable();

describe('e2e рендер', { skip: available ? false : 'ffmpeg/ffprobe недоступны' }, () => {
  let server;

  before(async () => {
    server = await startProgressServer();
  });

  after(async () => {
    await server?.close();
  });

  test('собирает валидный вертикальный MP4 и отчитывается по фазам', { timeout: 300_000 }, async () => {
    const { root } = await setupJob();
    const env = makeEnv(root, server.url);
    const logger = new Logger({ level: 'debug', sink: () => {} });
    const storage = createStorage(env);
    const reporter = makeReporter(env, logger);
    server.reports.length = 0;

    const { status, result } = await runRender({ env, storage, reporter, logger });
    assert.equal(status, 'succeeded');

    // ── Результат на месте и соответствует §4.3 ──────────────────────────
    assert.equal(result.objectPath, `projects/${PROJECT_ID}/jobs/${JOB_ID}/output/reel_1280p.mp4`);
    assert.equal(result.width, 720);
    assert.equal(result.height, 1280);
    assert.equal(result.fps, 30);
    assert.equal(result.videoCodec, 'h264');
    assert.equal(result.audioCodec, 'aac');
    assert.ok(result.sizeBytes > 1000, 'файл не должен быть пустым');
    assert.ok(result.checksumCrc32c, 'должна быть контрольная сумма');
    assert.ok(!Number.isNaN(Date.parse(result.renderedAt)));
    // Signed URL подписывает backend, у worker'а нет на это прав (§9).
    assert.equal(result.downloadUrl, null);

    // ── Файл действительно лежит в хранилище ────────────────────────────
    const videoPath = path.join(root, result.objectPath);
    const thumbPath = path.join(root, result.thumbnailObjectPath);
    assert.ok((await stat(videoPath)).size === result.sizeBytes);
    assert.ok((await stat(thumbPath)).size > 0, 'обложка должна быть выгружена');

    // ── ffprobe: контейнер, кодеки, кадр, звук ──────────────────────────
    const verification = await verifyOutput(FFPROBE, videoPath, {
      width: 720,
      height: 1280,
      fps: 30,
      durationSeconds: result.durationSeconds,
    });
    assert.deepEqual(verification.problems, [], 'ffprobe нашёл расхождения');
    assert.equal(verification.info.pixelFormat, 'yuv420p');
    assert.match(verification.info.formatName, /mp4/);

    // ── faststart ───────────────────────────────────────────────────────
    assert.equal(await hasFastStart(videoPath), true, 'moov должен идти перед mdat');

    // ── Прогресс: фазы по порядку, глобальный прогресс не убывает ────────
    const phases = server.reports.map((r) => r.phase);
    for (const phase of ['preparing', 'downloading', 'rendering', 'encoding', 'uploading', 'finalizing']) {
      assert.ok(phases.includes(phase), `не было отчёта о фазе ${phase}`);
    }
    assert.ok(server.reports.every((r) => r.authorization === 'Bearer e2e-worker-token-value'));

    const order = Object.keys(PHASES);
    let seen = -1;
    for (const report of server.reports) {
      const index = order.indexOf(report.phase);
      assert.ok(index >= seen, `фаза ${report.phase} пришла после более поздней`);
      seen = index;
    }

    // ── Временные файлы убраны ──────────────────────────────────────────
    assert.ok(env.workDir, 'тест должен задавать рабочий каталог явно');
    await assert.rejects(() => access(env.workDir), 'рабочий каталог не должен оставаться');
  });

  test('субтитры выгружаются рядом с роликом и содержат кириллицу', { timeout: 300_000 }, async () => {
    const { root } = await setupJob();
    const env = makeEnv(root, server.url);
    const logger = new Logger({ level: 'info', sink: () => {} });

    await runRender({ env, storage: createStorage(env), reporter: makeReporter(env, logger), logger });

    const srt = await readFile(
      path.join(root, `projects/${PROJECT_ID}/jobs/${JOB_ID}/output/captions.srt`),
      'utf8',
    );
    assert.match(srt, /-->/);
    assert.match(srt, /[А-Яа-яЁё]/, 'кириллица должна сохраниться');
  });

  test('фото превращается в клип с движением', { timeout: 300_000 }, async () => {
    const { root } = await setupJob();
    await makePhoto(path.join(root, `projects/${PROJECT_ID}/sources/asset_b.jpg`), {
      width: 800,
      height: 600,
    });

    const planPath = path.join(root, `projects/${PROJECT_ID}/jobs/${JOB_ID}/plan.json`);
    const document = JSON.parse(await readFile(planPath, 'utf8'));
    document.assets[1] = {
      id: 'asset_b',
      type: 'photo',
      objectPath: `projects/${PROJECT_ID}/sources/asset_b.jpg`,
      width: 800,
      height: 600,
    };
    document.plan.clips[1] = {
      id: 'clip_2',
      mediaId: 'asset_b',
      type: 'photo',
      duration: 2,
      transition: 'slide',
    };
    await writeFile(planPath, JSON.stringify(document));

    const env = makeEnv(root, server.url);
    const logger = new Logger({ level: 'info', sink: () => {} });
    const { result } = await runRender({
      env,
      storage: createStorage(env),
      reporter: makeReporter(env, logger),
      logger,
    });

    const videoPath = path.join(root, result.objectPath);
    const verification = await verifyOutput(FFPROBE, videoPath, {
      width: 720,
      height: 1280,
      fps: 30,
      durationSeconds: result.durationSeconds,
    });
    assert.deepEqual(verification.problems, []);
  });

  test('1080p с 60 fps собирается с параметрами своей строки §1', { timeout: 300_000 }, async () => {
    const { root } = await setupJob({ export: { resolution: 'fullHd1080', fps: 60 } });
    const env = makeEnv(root, server.url);
    const logger = new Logger({ level: 'info', sink: () => {} });

    const { result } = await runRender({
      env,
      storage: createStorage(env),
      reporter: makeReporter(env, logger),
      logger,
    });

    assert.equal(result.width, 1080);
    assert.equal(result.height, 1920);
    assert.equal(result.fps, 60);
    assert.equal(result.objectPath.endsWith('reel_1920p.mp4'), true);

    const verification = await verifyOutput(FFPROBE, path.join(root, result.objectPath), {
      width: 1080,
      height: 1920,
      fps: 60,
      durationSeconds: result.durationSeconds,
    });
    assert.deepEqual(verification.problems, []);
  });

  test('отмена останавливает рендер и убирает временные файлы', { timeout: 300_000 }, async () => {
    const { root } = await setupJob();
    const cancelServer = await startProgressServer({ cancelAfter: 2 });
    try {
      const env = makeEnv(root, cancelServer.url);
      const logger = new Logger({ level: 'info', sink: () => {} });

      await assert.rejects(
        () =>
          runRender({
            env,
            storage: createStorage(env),
            reporter: makeReporter(env, logger),
            logger,
          }),
        (err) => {
          assert.equal(err.code, 'CANCELLED_BY_USER');
          return true;
        },
      );

      // Готового ролика быть не должно.
      await assert.rejects(() =>
        access(path.join(root, `projects/${PROJECT_ID}/jobs/${JOB_ID}/output/reel_1280p.mp4`)),
      );
      // §8.1: при отмене worker обязан убрать за собой tmp.
      await assert.rejects(
        () => access(path.join(root, 'work')),
        'рабочий каталог должен быть убран и при отмене',
      );
    } finally {
      await cancelServer.close();
    }
  });

  test('повреждённый исходник даёт SOURCE_UNREADABLE, а не падение', { timeout: 300_000 }, async () => {
    const { root } = await setupJob();
    // Подменяем валидный MP4 мусором.
    await writeFile(path.join(root, `projects/${PROJECT_ID}/sources/asset_a.mp4`), 'не видео');

    const env = makeEnv(root, server.url);
    const logger = new Logger({ level: 'info', sink: () => {} });

    await assert.rejects(
      () =>
        runRender({ env, storage: createStorage(env), reporter: makeReporter(env, logger), logger }),
      (err) => {
        assert.equal(err.code, 'SOURCE_UNREADABLE');
        // Наружу не должно уйти ни путей, ни вывода ffprobe.
        assert.ok(!err.message.includes(root));
        assert.ok(!err.message.includes('ffprobe'));
        return true;
      },
    );
  });

  test('план с неверным разрешением отклоняется до запуска FFmpeg', { timeout: 60_000 }, async () => {
    const { root } = await setupJob({ export: { resolution: 'maximumAvailable' } });
    const env = makeEnv(root, server.url);
    const logger = new Logger({ level: 'info', sink: () => {} });

    await assert.rejects(
      () =>
        runRender({ env, storage: createStorage(env), reporter: makeReporter(env, logger), logger }),
      (err) => {
        assert.equal(err.code, 'RESOLUTION_UNSUPPORTED');
        return true;
      },
    );
  });

  test('видео с метаданными поворота нормализуется', { timeout: 300_000 }, async () => {
    const { root } = await setupJob();
    // Материал 640×480 в контейнере, но с поворотом 90° — на экране 480×640.
    await makeRotatedVideo(path.join(root, `projects/${PROJECT_ID}/sources/asset_a.mp4`), {
      duration: 4,
      width: 640,
      height: 480,
      rotation: 90,
    });

    const env = makeEnv(root, server.url);
    const logger = new Logger({ level: 'info', sink: () => {} });

    const { result } = await runRender({
      env,
      storage: createStorage(env),
      reporter: makeReporter(env, logger),
      logger,
    });

    const videoPath = path.join(root, result.objectPath);
    const verification = await verifyOutput(FFPROBE, videoPath, {
      width: 720,
      height: 1280,
      fps: 30,
      durationSeconds: result.durationSeconds,
    });
    assert.deepEqual(verification.problems, []);

    // В результате поворота быть не должно: кадр уже развёрнут, а метаданные
    // исходников сняты (-map_metadata -1).
    const probe = await runFfprobe(FFPROBE, videoPath);
    const video = probe.streams.find((s) => s.codec_type === 'video');
    assert.equal(rotationOf(video), 0, 'в результате не должно остаться поворота');
  });

  test('все четыре разрешения §1 собираются и проходят ffprobe', { timeout: 900_000 }, async () => {
    const expected = {
      hd720: [720, 1280],
      fullHd1080: [1080, 1920],
      twoK1440: [1440, 2560],
      fourK2160: [2160, 3840],
    };

    for (const [resolution, [width, height]] of Object.entries(expected)) {
      // Короткие клипы: цель — проверить параметры, а не нагрузить кодек.
      const { root } = await setupJob({
        export: { resolution, fps: 30 },
        plan: {
          clips: [
            { id: 'clip_1', mediaId: 'asset_a', type: 'video', duration: 1, start: 0, end: 1, transition: 'cut' },
            { id: 'clip_2', mediaId: 'asset_b', type: 'video', duration: 1, start: 0, end: 1, transition: 'crossfade' },
          ],
        },
      });
      const env = makeEnv(root, server.url);
      const logger = new Logger({ level: 'info', sink: () => {} });

      const { result } = await runRender({
        env,
        storage: createStorage(env),
        reporter: makeReporter(env, logger),
        logger,
      });

      assert.equal(result.width, width, resolution);
      assert.equal(result.height, height, resolution);
      assert.ok(result.objectPath.endsWith(`reel_${height}p.mp4`), resolution);

      const videoPath = path.join(root, result.objectPath);
      const verification = await verifyOutput(FFPROBE, videoPath, {
        width,
        height,
        fps: 30,
        durationSeconds: result.durationSeconds,
      });
      assert.deepEqual(verification.problems, [], resolution);
      assert.equal(await hasFastStart(videoPath), true, `${resolution}: faststart`);
    }
  });

  test('рендер работает и без канала прогресса (§10, автономный прогон)', { timeout: 300_000 }, async () => {
    const { root } = await setupJob();
    const env = makeEnv(root, '');
    const logger = new Logger({ level: 'info', sink: () => {} });

    const { status, result } = await runRender({
      env,
      storage: createStorage(env),
      reporter: makeReporter(env, logger),
      logger,
    });
    assert.equal(status, 'succeeded');
    assert.ok(result.sizeBytes > 1000);
  });
});
