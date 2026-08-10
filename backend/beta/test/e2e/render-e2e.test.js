// Герметичный сквозной e2e (§4D.2) — БЕЗ облака, через production routers и
// adapters:
//
//   upload → analysis → EditPlan v2 → render → worker-v2 → progress → download
//   → ffprobe
//
// Настоящий MP4 (никаких фикстур): LocalRenderLauncher запускает реальный код
// worker-v2 (node backend/worker-v2/src/index.js) в local-режиме против
// файловой «корзины». Storage-адаптер — файловая система. Прогресс идёт по
// production-каналу /internal/render/progress с токеном worker'а.
//
// Требует ffmpeg с libass и каталог шрифтов §5. В CI обязателен
// (REELIO_REQUIRE_E2E=1 → пропуск считается ошибкой); локально без libass
// пропускается.

import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { startServer, fakeGemini, fakeMedia } from '../helpers/harness.js';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
const WORKER_ENTRY = path.join(REPO_ROOT, 'backend/worker-v2/src/index.js');
const FONTS_DIR = process.env.REELIO_FONTS_DIR || '/usr/share/fonts/truetype/reelio';
const REQUIRE = process.env.REELIO_REQUIRE_E2E === '1';

function hasLibass() {
  try {
    const out = execFileSync(FFMPEG, ['-hide_banner', '-filters'], { encoding: 'utf8' });
    return / subtitles /.test(out);
  } catch {
    return false;
  }
}
const RUN = hasLibass();

function sh(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`${bin} exit ${code}: ${stderr.slice(-900)}`)),
    );
  });
}

/** Синтетический источник: видео testsrc2 + синус-аудио, 3 c. */
async function makeSource(filePath) {
  await sh(FFMPEG, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=30:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000',
    '-y', filePath,
  ]);
}

async function ffprobe(filePath) {
  const out = await sh(FFPROBE, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath,
  ]);
  return JSON.parse(out);
}

/** faststart: атом moov обязан идти РАНЬШЕ mdat. */
async function isFaststart(filePath) {
  const buf = await readFile(filePath);
  const moov = buf.indexOf(Buffer.from('moov'));
  const mdat = buf.indexOf(Buffer.from('mdat'));
  return moov > 0 && mdat > 0 && moov < mdat;
}

/** Файловый Storage-адаптер: подпись = file://, запись/чтение = ФС. */
function localSigner(root) {
  const full = (objectPath) => path.join(root, objectPath);
  return {
    async uploadUrl({ objectPath, contentType, ttlSeconds }) {
      await mkdir(path.dirname(full(objectPath)), { recursive: true });
      return {
        url: `file://${full(objectPath)}`,
        headers: { 'Content-Type': contentType },
        expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      };
    },
    async downloadUrl({ objectPath, ttlSeconds }) {
      return { url: `file://${full(objectPath)}`, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() };
    },
    async writeJson({ objectPath, data }) {
      await mkdir(path.dirname(full(objectPath)), { recursive: true });
      await writeFile(full(objectPath), JSON.stringify(data), 'utf8');
    },
  };
}

/** Запускает НАСТОЯЩИЙ worker-v2 в local-режиме и ждёт его завершения. */
function localLauncher({ root, bucket, token }) {
  return {
    async launch({ env }) {
      const localEnv = {
        ...env,
        REELIO_PLAN_URI: env.REELIO_PLAN_URI.replace(`gs://${bucket}/`, `file://${root}/`),
        REELIO_WORKER_TOKEN: token,
        REELIO_FONTS_DIR: FONTS_DIR,
        REELIO_X264_PRESET: 'ultrafast',
        REELIO_LOG_LEVEL: 'error',
      };
      await new Promise((resolve, reject) => {
        const child = spawn('node', [WORKER_ENTRY], {
          env: { ...process.env, ...localEnv },
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (d) => (stderr += d));
        child.on('error', reject);
        child.on('close', (code) =>
          code === 0 ? resolve() : reject(new Error(`worker-v2 exit ${code}: ${stderr.slice(-900)}`)),
        );
      });
      return { execution: 'local-exec' };
    },
  };
}

const TOKEN = 'e2e-worker-token';

function e2eConfig(bucket) {
  return {
    storage: { bucket, signedUrlTtlSeconds: 900, localRoot: '' },
    render: {
      workerJobName: 'reelio-ffmpeg-worker-v2',
      workerJobRegion: 'europe-west1',
      projectId: 'demo-reelio',
      workerToken: TOKEN,
      publicBaseUrl: '', // выставим после listen
      resultTtlDays: 7,
      maxActivePerUser: 1,
    },
  };
}

function buildPlan({ keepOriginal }) {
  return {
    id: 'plan_e2e',
    style: 'dynamicStyle',
    durationSeconds: 4,
    audio: { keepOriginal },
    captions: { enabled: false, language: 'ru', style: 'bold' },
    coverClipId: 'c1',
    textOverlays: [
      {
        id: 't1',
        text: 'ПРИВЕТ МИР',
        startSeconds: 0,
        endSeconds: 4,
        position: { anchor: 'center', x: 0.5, y: 0.5 },
        fontId: 'montserrat',
        fontWeight: 'bold',
        fontSizeRatio: 0.08,
        colorHex: '#FFFFFF',
        outline: { colorHex: '#000000', widthRatio: 0.008 },
        animation: 'none',
      },
    ],
    clips: [
      { id: 'c1', mediaId: 'asset_1', type: 'video', duration: 2, start: 0, end: 2, transition: 'cut' },
      { id: 'c2', mediaId: 'asset_2', type: 'video', duration: 2, start: 0, end: 2, transition: 'dissolve' },
    ],
  };
}

async function runChain(keepOriginal, { withAnalysis }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reelio-e2e-'));
  const bucket = 'e2e-bucket';
  const config = e2eConfig(bucket);
  const harness = await startServer({
    config,
    render: { signer: localSigner(root), jobs: localLauncher({ root, bucket, token: TOKEN }) },
    gemini: fakeGemini(),
    media: fakeMedia(),
  });
  // Канал прогресса worker'а указывает на этот сервер (адрес известен после listen).
  harness.config.render.publicBaseUrl = harness.base;

  try {
    const uid = 'user_1';
    const projectId = 'proj_e2e';

    // 1. Uploads: пути строит сервер; байты кладём по выданным objectPath.
    const up = await harness.request('POST', '/uploads', {
      body: {
        projectId,
        assets: [
          { id: 'asset_1', type: 'video', contentType: 'video/mp4' },
          { id: 'asset_2', type: 'video', contentType: 'video/mp4' },
        ],
      },
    });
    assert.equal(up.status, 200);
    const objectPaths = {};
    for (const t of up.body.uploads) {
      const full = path.join(root, t.objectPath);
      await mkdir(path.dirname(full), { recursive: true });
      await makeSource(full);
      objectPaths[t.assetId] = t.objectPath;
    }

    // 2. Analysis → EditPlan v2 (лег анализа; рендерим детерминированный план).
    if (withAnalysis) {
      const created = await harness.request('POST', '/analysis', {
        body: {
          projectId,
          assets: [
            { id: 'asset_1', type: 'video', objectPath: objectPaths.asset_1, durationSeconds: 3 },
            { id: 'asset_2', type: 'video', objectPath: objectPaths.asset_2, durationSeconds: 3 },
          ],
        },
      });
      const analysisId = created.body.analysis.analysisId;
      let status = 'queued';
      for (let i = 0; i < 200 && !['succeeded', 'failed', 'cancelled'].includes(status); i += 1) {
        await new Promise((r) => setTimeout(r, 20));
        const s = await harness.request('GET', `/analysis/${analysisId}`);
        status = s.body.analysis.status;
      }
      assert.equal(status, 'succeeded', 'анализ завершился успешно');
      const plan = await harness.request('POST', `/analysis/${analysisId}/plan`, { body: { prompt: 'ролик' } });
      assert.equal(plan.status, 200);
      assert.ok(plan.body.plan.clips.length > 0, 'анализ дал EditPlan v2 с клипами');
      assert.equal(plan.body.contractVersion, 2);
    }

    // 3. Render детерминированного v2-плана (переход + русский TextOverlay).
    const render = await harness.request('POST', '/render', {
      body: {
        projectId,
        plan: buildPlan({ keepOriginal }),
        assets: [
          { id: 'asset_1', type: 'video', objectPath: objectPaths.asset_1 },
          { id: 'asset_2', type: 'video', objectPath: objectPaths.asset_2 },
        ],
        export: { resolution: 'fullHd1080', fps: 30 },
      },
    });
    assert.ok([200, 202].includes(render.status), `render status ${render.status}: ${JSON.stringify(render.body)}`);
    const jobId = render.body.jobId;

    // 4. Ждём терминал (worker уже отработал в launch, но подстрахуемся).
    let job = render.body;
    for (let i = 0; i < 50 && job.status !== 'succeeded'; i += 1) {
      await new Promise((r) => setTimeout(r, 40));
      job = (await harness.request('GET', `/jobs/${jobId}`)).body;
      if (job.status === 'failed') assert.fail(`рендер провалился: ${JSON.stringify(job.error)}`);
    }
    assert.equal(job.status, 'succeeded', 'рендер успешен');

    // 5. Download → путь MP4 в «корзине».
    const dl = await harness.request('GET', `/download?jobId=${jobId}`);
    assert.equal(dl.status, 200);
    const mp4 = path.join(root, dl.body.downloadUrl.replace(`file://${root}/`, ''));
    const size = (await stat(mp4)).size;
    assert.ok(size > 1000, `MP4 непустой (${size} байт)`);

    // 6. ffprobe: настоящий MP4, а не фикстура.
    const probe = await ffprobe(mp4);
    const v = probe.streams.find((s) => s.codec_type === 'video');
    const a = probe.streams.find((s) => s.codec_type === 'audio');
    return { probe, v, a, mp4, root };
  } finally {
    // root чистим в вызывающем тесте после ассертов (нужен файл для ffprobe).
    harness._root = root;
    await harness.close();
  }
}

test('e2e: переход + русский TextOverlay + keepOriginal=true → H.264/AAC 48 kHz, 9:16, 30fps, yuv420p, faststart', { skip: !RUN && !REQUIRE }, async () => {
  if (REQUIRE && !RUN) throw new Error('e2e обязателен в CI, но ffmpeg без libass');
  const { probe, v, a, mp4, root } = await runChain(true, { withAnalysis: true });
  try {
    assert.equal(v.codec_name, 'h264', 'видео H.264');
    assert.equal(v.pix_fmt, 'yuv420p');
    assert.equal(v.width, 1080);
    assert.equal(v.height, 1920);
    const fps = Number(v.avg_frame_rate.split('/')[0]) / Number(v.avg_frame_rate.split('/')[1]);
    assert.ok(Math.abs(fps - 30) < 0.5, `30 FPS (получено ${fps})`);
    assert.ok(a, 'при keepOriginal=true аудиопоток есть');
    assert.equal(a.codec_name, 'aac');
    assert.equal(Number(a.sample_rate), 48000, 'AAC 48 kHz');
    const dur = Number(probe.format.duration);
    assert.ok(dur > 2 && dur < 8, `длительность в разумных пределах (${dur}s)`);
    assert.ok(await isFaststart(mp4), 'faststart: moov раньше mdat');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('e2e: keepOriginal=false → H.264 MP4 без аудиопотока', { skip: !RUN && !REQUIRE }, async () => {
  if (REQUIRE && !RUN) throw new Error('e2e обязателен в CI, но ffmpeg без libass');
  const { v, a, mp4, root } = await runChain(false, { withAnalysis: false });
  try {
    assert.equal(v.codec_name, 'h264');
    assert.equal(v.width, 1080);
    assert.equal(v.height, 1920);
    assert.equal(a, undefined, 'аудиопотока нет вовсе при keepOriginal=false');
    assert.ok(await isFaststart(mp4), 'faststart сохранён');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
