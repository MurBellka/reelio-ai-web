// Тесты HTTP-контракта: /render, /jobs/{id}, /jobs/{id}/cancel, /download
// и внутренний канал прогресса. Всё в local mode — без облачных ресурсов.

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../src/app.js';

const WORKER_TOKEN = 'test-worker-token';
const PROJECT = 'proj_test';

function testConfig(root, overrides = {}, limits = {}) {
  return {
    port: 0,
    gemini: { apiKey: '', model: 'gemini-2.5-flash' },
    rateLimits: { editPlan: 1000, render: 1000, cancel: 1000, poll: 1000, ...limits },
    allowedOrigins: new Set(['http://localhost:5353']),
    render: {
      mode: 'local',
      bucket: '',
      gcpProject: '',
      firestoreDatabase: '(default)',
      jobName: '',
      jobRegion: 'europe-west1',
      signedUrlTtlSeconds: 3600,
      jobTtlDays: 7,
      heartbeatTimeoutMs: 600_000,
      localRoot: root,
      localWorkerCmd: '',
      publicBaseUrl: '',
      workerToken: WORKER_TOKEN,
      ...overrides,
    },
  };
}

/** Поднимает приложение на свободном порту. */
async function startApp(overrides = {}, limits = {}) {
  const root = await mkdtemp(join(tmpdir(), 'reelio-test-'));
  const config = testConfig(root, overrides, limits);
  const app = await createApp(config);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  // publicBaseUrl нужен для локальных «подписанных» ссылок.
  config.render.publicBaseUrl = baseUrl;
  app.locals.storage.baseUrl = baseUrl;

  return {
    baseUrl,
    app,
    config,
    root,
    async close() {
      await new Promise((r) => server.close(r));
      await rm(root, { recursive: true, force: true });
    },
  };
}

function renderBody(overrides = {}) {
  const projectId = overrides.projectId || PROJECT;
  return {
    contractVersion: 1,
    projectId,
    assets: [
      {
        id: 'asset_a',
        type: 'video',
        objectPath: `projects/${projectId}/sources/asset_a.mp4`,
        durationSeconds: 40,
        width: 1080,
        height: 1920,
      },
    ],
    plan: {
      id: 'plan_1',
      prompt: 'тест',
      style: 'dynamicStyle',
      durationSeconds: 8,
      captions: { enabled: true, language: 'ru', style: 'bold', colorHex: '#FFFFFF' },
      music: { track: 'chill', volume: 0.7 },
      clips: [
        { id: 'clip_1', mediaId: 'asset_a', type: 'video', duration: 8, start: 0, end: 8, transition: 'cut' },
      ],
    },
    export: { resolution: 'fullHd1080', fps: 30 },
    ...overrides,
  };
}

async function post(baseUrl, path, body, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
}

async function get(baseUrl, path, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, { headers });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* не JSON — например, бинарный ответ */
  }
  return { status: res.status, body: parsed, text, headers: res.headers };
}

function workerHeaders(token = WORKER_TOKEN) {
  return { Authorization: `Bearer ${token}` };
}

/** Кладёт «готовый» файл в локальное хранилище вместо реального worker'а. */
async function putOutput(ctx, objectPath, content = 'fake-mp4') {
  const full = ctx.app.locals.storage.localFilePath(objectPath);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content);
  return full;
}

describe('health', () => {
  let ctx;
  before(async () => {
    ctx = await startApp();
  });
  after(() => ctx.close());

  it('сообщает версию контракта и режим рендера без секретов', async () => {
    const res = await get(ctx.baseUrl, '/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.contractVersion, 1);
    assert.equal(res.body.render.mode, 'local');
    assert.equal(JSON.stringify(res.body).includes(WORKER_TOKEN), false);
  });
});

describe('POST /uploads', () => {
  let ctx;
  before(async () => {
    ctx = await startApp();
  });
  after(() => ctx.close());

  function uploadBody(projectId = PROJECT, overrides = {}) {
    return {
      contractVersion: 1,
      projectId,
      assets: [
        {
          id: 'asset_a',
          type: 'video',
          objectPath: `projects/${projectId}/sources/asset_a.mp4`,
          contentType: 'video/mp4',
          sizeBytes: 1024,
        },
        {
          id: 'asset_b',
          type: 'photo',
          objectPath: `projects/${projectId}/sources/asset_b.jpg`,
          contentType: 'image/jpeg',
        },
      ],
      ...overrides,
    };
  }

  it('выдаёт по разрешению на каждый материал', async () => {
    const res = await post(ctx.baseUrl, '/uploads', uploadBody('proj_up'));
    assert.equal(res.status, 200);
    assert.equal(res.body.contractVersion, 1);
    assert.equal(res.body.uploads.length, 2);

    const [first] = res.body.uploads;
    assert.equal(first.assetId, 'asset_a');
    assert.equal(first.objectPath, 'projects/proj_up/sources/asset_a.mp4');
    assert.equal(first.method, 'PUT');
    assert.equal(first.headers['Content-Type'], 'video/mp4');
    assert.ok(first.uploadUrl);
    assert.ok(first.expiresAt > new Date().toISOString());
  });

  it('загруженный файл попадает по пути из разрешения', async () => {
    const res = await post(ctx.baseUrl, '/uploads', uploadBody('proj_put'));
    const ticket = res.body.uploads[0];

    const put = await fetch(ticket.uploadUrl, {
      method: ticket.method,
      headers: ticket.headers,
      body: 'video-bytes-here',
    });
    assert.equal(put.status, 200);

    assert.equal(await ctx.app.locals.storage.exists(ticket.objectPath), true);
    const stat = await ctx.app.locals.storage.statObject(ticket.objectPath);
    assert.equal(stat.sizeBytes, 'video-bytes-here'.length);
  });

  it('подпись привязана к типу содержимого', async () => {
    const res = await post(ctx.baseUrl, '/uploads', uploadBody('proj_ct'));
    const ticket = res.body.uploads[0];
    const put = await fetch(ticket.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/html' },
      body: '<script>alert(1)</script>',
    });
    assert.equal(put.status, 400);
  });

  it('поддельная подпись отклоняется', async () => {
    const res = await post(ctx.baseUrl, '/uploads', uploadBody('proj_forge'));
    const tampered = res.body.uploads[0].uploadUrl.replace(/sig=[a-f0-9]+/, 'sig=deadbeef');
    const put = await fetch(tampered, {
      method: 'PUT',
      headers: { 'Content-Type': 'video/mp4' },
      body: 'x',
    });
    assert.equal(put.status, 403);
  });

  it('запись вне sources/ проекта запрещена', async () => {
    const body = uploadBody('proj_esc');
    body.assets[0].objectPath = 'projects/proj_esc/jobs/job_1/output/reel_1920p.mp4';
    const res = await post(ctx.baseUrl, '/uploads', body);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'INVALID_OBJECT_PATH');
  });

  it('запись в чужой проект запрещена', async () => {
    const body = uploadBody('proj_mine');
    body.assets[0].objectPath = 'projects/victim/sources/asset_a.mp4';
    const res = await post(ctx.baseUrl, '/uploads', body);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'INVALID_OBJECT_PATH');
  });

  it('неподдерживаемый тип содержимого отклоняется', async () => {
    const body = uploadBody('proj_type');
    body.assets[0].contentType = 'application/x-sh';
    const res = await post(ctx.baseUrl, '/uploads', body);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'INVALID_REQUEST');
    assert.match(res.body.error.field, /contentType/);
  });

  it('чужая версия контракта отклоняется', async () => {
    const res = await post(ctx.baseUrl, '/uploads', uploadBody(PROJECT, { contractVersion: 2 }));
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'CONTRACT_VERSION_UNSUPPORTED');
  });
});

describe('POST /render', () => {
  let ctx;
  before(async () => {
    ctx = await startApp();
  });
  after(() => ctx.close());

  it('создаёт задачу и возвращает 202 с RenderJob', async () => {
    const res = await post(ctx.baseUrl, '/render', renderBody());
    assert.equal(res.status, 202);
    const job = res.body;
    assert.equal(job.contractVersion, 1);
    assert.match(job.jobId, /^job_/);
    assert.equal(job.projectId, PROJECT);
    assert.equal(job.planId, 'plan_1');
    assert.equal(job.status, 'queued');
    assert.equal(job.phase, 'queued');
    assert.equal(job.progress, 0);
    assert.equal(job.attempt, 1);
    assert.equal(job.export.resolution, 'fullHd1080');
    assert.equal(job.export.width, 1080);
    assert.equal(job.export.height, 1920);
    assert.equal(job.result, null);
    assert.equal(job.error, null);
    assert.ok(job.expiresAt > job.createdAt);
  });

  it('не отдаёт клиенту внутренние поля', async () => {
    const res = await post(ctx.baseUrl, '/render', renderBody({ projectId: 'proj_internal' }));
    for (const hidden of ['executionName', 'fingerprint', 'contentHash', 'planObjectPath', 'plan', 'assets']) {
      assert.equal(hidden in res.body, false, `поле ${hidden} не должно уходить клиенту`);
    }
  });

  it('сохраняет plan.json по пути из контракта', async () => {
    const res = await post(ctx.baseUrl, '/render', renderBody({ projectId: 'proj_plan' }));
    const snapshot = await ctx.app.locals.storage.readJson(
      `projects/proj_plan/jobs/${res.body.jobId}/plan.json`,
    );
    assert.equal(snapshot.contractVersion, 1);
    assert.equal(snapshot.plan.id, 'plan_1');
    assert.equal(snapshot.assets[0].objectPath, 'projects/proj_plan/sources/asset_a.mp4');
    assert.equal(
      snapshot.output.videoObjectPath,
      `projects/proj_plan/jobs/${res.body.jobId}/output/reel_1920p.mp4`,
    );
  });

  it('резолвит maximumAvailable в конкретное разрешение', async () => {
    const body = renderBody({ projectId: 'proj_auto', export: { resolution: 'maximumAvailable' } });
    body.assets[0].width = 720;
    body.assets[0].height = 1280;
    const res = await post(ctx.baseUrl, '/render', body);
    assert.equal(res.body.export.resolution, 'hd720');
    assert.equal(res.body.export.isUpscale, false);
  });

  it('отклоняет некорректный план в формате ошибок контракта', async () => {
    const body = renderBody({ projectId: 'proj_bad' });
    body.plan.clips[0].mediaId = 'unknown';
    const res = await post(ctx.baseUrl, '/render', body);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'ASSET_MISSING');
    assert.equal(res.body.error.retryable, false);
    assert.match(res.body.error.field, /mediaId/);
    assert.match(res.body.error.requestId, /^req_/);
  });

  it('отклоняет чужой objectPath', async () => {
    const body = renderBody({ projectId: 'proj_path' });
    body.assets[0].objectPath = 'projects/victim/sources/a.mp4';
    const res = await post(ctx.baseUrl, '/render', body);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'INVALID_OBJECT_PATH');
  });
});

describe('защита от дубликатов', () => {
  let ctx;
  before(async () => {
    ctx = await startApp();
  });
  after(() => ctx.close());

  it('одинаковый запрос без ключа даёт ту же задачу с 200', async () => {
    const body = renderBody({ projectId: 'proj_dup' });
    const first = await post(ctx.baseUrl, '/render', body);
    const second = await post(ctx.baseUrl, '/render', body);
    assert.equal(first.status, 202);
    assert.equal(second.status, 200);
    assert.equal(second.body.jobId, first.body.jobId);
    assert.equal(second.body.attempt, 1);
  });

  it('косметические правки плана не создают новую задачу', async () => {
    const body = renderBody({ projectId: 'proj_cosmetic' });
    const first = await post(ctx.baseUrl, '/render', body);

    const cosmetic = renderBody({ projectId: 'proj_cosmetic' });
    cosmetic.plan.clips[0].sourceName = 'IMG_0042.mp4';
    cosmetic.plan.clips[0].reason = 'другая причина';
    cosmetic.plan.clips[0].filePath = '/tmp/local.mp4';
    const second = await post(ctx.baseUrl, '/render', cosmetic);

    assert.equal(second.status, 200);
    assert.equal(second.body.jobId, first.body.jobId);
  });

  it('реальное изменение плана создаёт новую задачу', async () => {
    const body = renderBody({ projectId: 'proj_changed' });
    const first = await post(ctx.baseUrl, '/render', body);

    const changed = renderBody({ projectId: 'proj_changed' });
    changed.plan.clips[0].end = 5;
    changed.plan.clips[0].duration = 5;
    const second = await post(ctx.baseUrl, '/render', changed);

    assert.equal(second.status, 202);
    assert.notEqual(second.body.jobId, first.body.jobId);
  });

  it('тот же Idempotency-Key с другим содержимым — 409', async () => {
    const headers = { 'Idempotency-Key': 'key-1' };
    const first = await post(ctx.baseUrl, '/render', renderBody({ projectId: 'proj_key' }), headers);
    assert.equal(first.status, 202);

    const changed = renderBody({ projectId: 'proj_key' });
    changed.plan.durationSeconds = 12;
    const second = await post(ctx.baseUrl, '/render', changed, headers);

    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
  });

  it('параллельные одинаковые запросы дают одну задачу', async () => {
    const body = renderBody({ projectId: 'proj_race' });
    const results = await Promise.all([
      post(ctx.baseUrl, '/render', body),
      post(ctx.baseUrl, '/render', body),
      post(ctx.baseUrl, '/render', body),
    ]);
    const ids = new Set(results.map((r) => r.body.jobId));
    assert.equal(ids.size, 1, 'должна создаться ровно одна задача');
    assert.equal(results.filter((r) => r.status === 202).length, 1);
  });

  it('лимит активных задач на проект — 429', async () => {
    const a = await post(ctx.baseUrl, '/render', renderBody({ projectId: 'proj_limit' }));
    const b = renderBody({ projectId: 'proj_limit' });
    b.plan.durationSeconds = 9;
    const c = renderBody({ projectId: 'proj_limit' });
    c.plan.durationSeconds = 10;

    assert.equal(a.status, 202);
    assert.equal((await post(ctx.baseUrl, '/render', b)).status, 202);

    const third = await post(ctx.baseUrl, '/render', c);
    assert.equal(third.status, 429);
    assert.equal(third.body.error.code, 'TOO_MANY_ACTIVE_JOBS');
    assert.equal(third.body.error.retryable, true);
  });
});

describe('GET /jobs/{id}', () => {
  let ctx;
  before(async () => {
    ctx = await startApp();
  });
  after(() => ctx.close());

  it('отдаёт состояние и поддерживает ETag', async () => {
    const created = await post(ctx.baseUrl, '/render', renderBody({ projectId: 'proj_get' }));
    const first = await get(ctx.baseUrl, `/jobs/${created.body.jobId}`);
    assert.equal(first.status, 200);
    assert.equal(first.body.jobId, created.body.jobId);
    assert.equal(first.headers.get('cache-control'), 'no-store');

    const etag = first.headers.get('etag');
    assert.ok(etag);
    const cached = await get(ctx.baseUrl, `/jobs/${created.body.jobId}`, { 'If-None-Match': etag });
    assert.equal(cached.status, 304);
  });

  it('неизвестная задача — 404 JOB_NOT_FOUND', async () => {
    const res = await get(ctx.baseUrl, '/jobs/job_unknown');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'JOB_NOT_FOUND');
  });

  it('некорректный идентификатор не приводит к 500', async () => {
    const res = await get(ctx.baseUrl, '/jobs/..%2F..%2Fetc');
    assert.equal(res.status, 404);
  });
});

describe('канал прогресса worker → backend', () => {
  let ctx;
  before(async () => {
    ctx = await startApp();
  });
  after(() => ctx.close());

  async function newJob(projectId) {
    const res = await post(ctx.baseUrl, '/render', renderBody({ projectId }));
    return res.body;
  }

  it('без токена — 401', async () => {
    const job = await newJob('proj_auth');
    const res = await post(ctx.baseUrl, `/internal/jobs/${job.jobId}/progress`, { phase: 'preparing' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'UNAUTHENTICATED');
  });

  it('токен с хвостовым переводом строки принимается', async () => {
    // Секрет из Secret Manager часто несёт \n (openssl … | gcloud … --data-file=-).
    // В заголовке Authorization он не выживает, поэтому config обязан его срезать,
    // иначе worker получает вечный 401 и задача навсегда виснет в queued.
    const dirty = await startApp({ workerToken: `${WORKER_TOKEN}\n` });
    try {
      const created = await post(dirty.baseUrl, '/render', renderBody({ projectId: 'proj_trim' }));
      const res = await post(
        dirty.baseUrl,
        `/internal/jobs/${created.body.jobId}/progress`,
        { phase: 'preparing' },
        { Authorization: `Bearer ${WORKER_TOKEN}` },
      );
      assert.equal(res.status, 200, 'токен с \\n должен совпасть с очищенным');
    } finally {
      await dirty.close();
    }
  });

  it('с чужим токеном — 401', async () => {
    const job = await newJob('proj_auth2');
    const res = await post(
      ctx.baseUrl,
      `/internal/jobs/${job.jobId}/progress`,
      { phase: 'preparing' },
      workerHeaders('wrong-token'),
    );
    assert.equal(res.status, 401);
  });

  it('ведёт задачу по этапам с монотонным прогрессом', async () => {
    const job = await newJob('proj_flow');
    const seen = [];
    for (const [phase, fraction] of [
      ['preparing', 1],
      ['downloading', 0.5],
      ['downloading', 1],
      ['rendering', 0.5],
      ['encoding', 0.5],
      ['uploading', 1],
      ['finalizing', 0.5],
    ]) {
      const res = await post(
        ctx.baseUrl,
        `/internal/jobs/${job.jobId}/progress`,
        { phase, fraction },
        workerHeaders(),
      );
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.cancelRequested, false);

      const state = await get(ctx.baseUrl, `/jobs/${job.jobId}`);
      seen.push(state.body.progress);
      assert.equal(state.body.status, 'running');
      assert.equal(state.body.phase, phase);
      assert.ok(state.body.startedAt, 'startedAt должен появиться при running');
    }
    const sorted = [...seen].sort((a, b) => a - b);
    assert.deepEqual(seen, sorted, `прогресс не должен убывать: ${seen}`);
  });

  it('прогресс назад не откатывает шкалу', async () => {
    const job = await newJob('proj_back');
    await post(ctx.baseUrl, `/internal/jobs/${job.jobId}/progress`, { phase: 'encoding', fraction: 1 }, workerHeaders());
    const high = (await get(ctx.baseUrl, `/jobs/${job.jobId}`)).body.progress;

    await post(ctx.baseUrl, `/internal/jobs/${job.jobId}/progress`, { phase: 'downloading', fraction: 0 }, workerHeaders());
    const after = (await get(ctx.baseUrl, `/jobs/${job.jobId}`)).body;
    assert.ok(after.progress >= high, 'progress не должен уменьшаться');
  });

  it('неизвестный этап — 400', async () => {
    const job = await newJob('proj_phase');
    const res = await post(
      ctx.baseUrl,
      `/internal/jobs/${job.jobId}/progress`,
      { phase: 'transcoding' },
      workerHeaders(),
    );
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'INVALID_REQUEST');
  });

  it('done без реального файла отклоняется', async () => {
    const job = await newJob('proj_nofile');
    const res = await post(
      ctx.baseUrl,
      `/internal/jobs/${job.jobId}/progress`,
      { phase: 'done', result: { objectPath: `projects/proj_nofile/jobs/${job.jobId}/output/reel_1920p.mp4` } },
      workerHeaders(),
    );
    assert.equal(res.status, 400);
  });

  it('результат вне каталога задачи отклоняется', async () => {
    const job = await newJob('proj_escape');
    await putOutput(ctx, 'projects/victim/jobs/other/output/reel_1920p.mp4');
    const res = await post(
      ctx.baseUrl,
      `/internal/jobs/${job.jobId}/progress`,
      { phase: 'done', result: { objectPath: 'projects/victim/jobs/other/output/reel_1920p.mp4' } },
      workerHeaders(),
    );
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'INVALID_OBJECT_PATH');
  });

  it('сообщение об ошибке worker\'а попадает в задачу', async () => {
    const job = await newJob('proj_fail');
    const res = await post(
      ctx.baseUrl,
      `/internal/jobs/${job.jobId}/progress`,
      { phase: 'failed', error: { code: 'SOURCE_UNREADABLE', message: 'Файл повреждён' } },
      workerHeaders(),
    );
    assert.equal(res.status, 200);

    const state = await get(ctx.baseUrl, `/jobs/${job.jobId}`);
    assert.equal(state.body.status, 'failed');
    assert.equal(state.body.error.code, 'SOURCE_UNREADABLE');
    assert.equal(state.body.error.retryable, false);
    assert.ok(state.body.finishedAt);
  });

  it('после терминального состояния отчёты отклоняются', async () => {
    const job = await newJob('proj_terminal');
    await post(ctx.baseUrl, `/internal/jobs/${job.jobId}/progress`, { phase: 'failed' }, workerHeaders());
    const late = await post(
      ctx.baseUrl,
      `/internal/jobs/${job.jobId}/progress`,
      { phase: 'encoding', fraction: 0.5 },
      workerHeaders(),
    );
    assert.equal(late.status, 409);
    assert.equal(late.body.error.code, 'JOB_ALREADY_TERMINAL');
  });
});

describe('успешное завершение и /download', () => {
  let ctx;
  before(async () => {
    ctx = await startApp();
  });
  after(() => ctx.close());

  async function succeed(projectId, content = 'fake-mp4-bytes') {
    const created = await post(ctx.baseUrl, '/render', renderBody({ projectId }));
    const job = created.body;
    const objectPath = `projects/${projectId}/jobs/${job.jobId}/output/reel_1920p.mp4`;
    await putOutput(ctx, objectPath, content);
    await putOutput(ctx, `projects/${projectId}/jobs/${job.jobId}/output/thumbnail.jpg`, 'jpg');
    const res = await post(
      ctx.baseUrl,
      `/internal/jobs/${job.jobId}/progress`,
      { phase: 'done', result: { objectPath, durationSeconds: 8, width: 1080, height: 1920, fps: 30 } },
      workerHeaders(),
    );
    assert.equal(res.status, 200);
    return { job, objectPath };
  }

  it('/download до готовности — 404 RESULT_NOT_READY', async () => {
    const created = await post(ctx.baseUrl, '/render', renderBody({ projectId: 'proj_early' }));
    const res = await get(ctx.baseUrl, `/download?jobId=${created.body.jobId}`);
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'RESULT_NOT_READY');
  });

  it('успешная задача содержит RenderResult и ссылку', async () => {
    const { job, objectPath } = await succeed('proj_ok');
    const state = await get(ctx.baseUrl, `/jobs/${job.jobId}`);

    assert.equal(state.body.status, 'succeeded');
    assert.equal(state.body.phase, 'done');
    assert.equal(state.body.progress, 1);
    assert.ok(state.body.finishedAt);

    const r = state.body.result;
    assert.equal(r.objectPath, objectPath);
    assert.equal(r.width, 1080);
    assert.equal(r.height, 1920);
    assert.equal(r.fps, 30);
    assert.equal(r.videoCodec, 'h264');
    assert.equal(r.audioCodec, 'aac');
    // Размер берётся из хранилища, а не со слов worker'а.
    assert.equal(r.sizeBytes, 'fake-mp4-bytes'.length);
    assert.ok(r.downloadUrl);
    assert.ok(r.downloadUrlExpiresAt > new Date().toISOString());
    assert.ok(r.thumbnailUrl);
  });

  it('/download выдаёт рабочую ссылку на файл', async () => {
    const { job } = await succeed('proj_dl', 'binary-content-here');
    const res = await get(ctx.baseUrl, `/download?jobId=${job.jobId}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.sizeBytes, 'binary-content-here'.length);
    assert.match(res.body.fileName, /^reelio_1920p_job_.*\.mp4$/);
    assert.ok(res.body.expiresAt);

    const file = await get('', res.body.downloadUrl);
    assert.equal(file.status, 200);
    assert.equal(file.text, 'binary-content-here');
  });

  it('поддельная подпись ссылки отклоняется', async () => {
    const { job } = await succeed('proj_sig');
    const res = await get(ctx.baseUrl, `/download?jobId=${job.jobId}`);
    const tampered = res.body.downloadUrl.replace(/sig=[a-f0-9]+/, 'sig=deadbeef');
    const file = await get('', tampered);
    assert.equal(file.status, 403);
  });

  it('redirect=1 отдаёт 302 на подписанную ссылку', async () => {
    const { job } = await succeed('proj_redirect');
    const res = await fetch(`${ctx.baseUrl}/download?jobId=${job.jobId}&redirect=1`, {
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /download\/file\?/);
  });

  it('повторный /render успешной задачи возвращает её же со свежей ссылкой', async () => {
    const { job } = await succeed('proj_reuse');
    const again = await post(ctx.baseUrl, '/render', renderBody({ projectId: 'proj_reuse' }));
    assert.equal(again.status, 200);
    assert.equal(again.body.jobId, job.jobId);
    assert.equal(again.body.status, 'succeeded');
    assert.ok(again.body.result.downloadUrl);
  });
});

describe('POST /jobs/{id}/cancel', () => {
  let ctx;
  before(async () => {
    ctx = await startApp();
  });
  after(() => ctx.close());

  it('отменяет задачу в очереди', async () => {
    const created = await post(ctx.baseUrl, '/render', renderBody({ projectId: 'proj_cancel' }));
    const res = await post(ctx.baseUrl, `/jobs/${created.body.jobId}/cancel`);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'cancelled');
    assert.equal(res.body.cancelRequested, true);
    assert.equal(res.body.error.code, 'CANCELLED_BY_USER');
    assert.ok(res.body.finishedAt);
  });

  it('повторная отмена идемпотентна', async () => {
    const created = await post(ctx.baseUrl, '/render', renderBody({ projectId: 'proj_cancel2' }));
    await post(ctx.baseUrl, `/jobs/${created.body.jobId}/cancel`);
    const again = await post(ctx.baseUrl, `/jobs/${created.body.jobId}/cancel`);
    assert.equal(again.status, 200);
    assert.equal(again.body.status, 'cancelled');
  });

  it('отменённая задача освобождает лимит проекта', async () => {
    const p = 'proj_cancel_slot';
    const first = await post(ctx.baseUrl, '/render', renderBody({ projectId: p }));
    const b = renderBody({ projectId: p });
    b.plan.durationSeconds = 9;
    await post(ctx.baseUrl, '/render', b);

    const c = renderBody({ projectId: p });
    c.plan.durationSeconds = 10;
    assert.equal((await post(ctx.baseUrl, '/render', c)).status, 429);

    await post(ctx.baseUrl, `/jobs/${first.body.jobId}/cancel`);
    assert.equal((await post(ctx.baseUrl, '/render', c)).status, 202);
  });

  it('отмена завершённой задачи — 409', async () => {
    const created = await post(ctx.baseUrl, '/render', renderBody({ projectId: 'proj_cancel3' }));
    await post(
      ctx.baseUrl,
      `/internal/jobs/${created.body.jobId}/progress`,
      { phase: 'failed' },
      workerHeaders(),
    );
    const res = await post(ctx.baseUrl, `/jobs/${created.body.jobId}/cancel`);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'JOB_ALREADY_TERMINAL');
  });

  it('отмена неизвестной задачи — 404', async () => {
    const res = await post(ctx.baseUrl, '/jobs/job_nope/cancel');
    assert.equal(res.status, 404);
  });

  it('после отмены новый рендер того же плана создаёт новую попытку', async () => {
    const body = renderBody({ projectId: 'proj_retry' });
    const first = await post(ctx.baseUrl, '/render', body);
    await post(ctx.baseUrl, `/jobs/${first.body.jobId}/cancel`);

    const second = await post(ctx.baseUrl, '/render', body);
    assert.equal(second.status, 202);
    assert.notEqual(second.body.jobId, first.body.jobId);
    assert.equal(second.body.attempt, 2);
  });
});

describe('лимиты запросов', () => {
  it('429 приходит в конверте контракта, а не простым текстом', async () => {
    const ctx = await startApp({}, { render: 2 });
    try {
      const body = renderBody({ projectId: 'proj_rl' });
      let last;
      for (let i = 0; i < 5; i += 1) {
        last = await post(ctx.baseUrl, '/render', body, { 'Idempotency-Key': `k${i}` });
      }
      assert.equal(last.status, 429);
      // §7: любой не-2xx обязан быть JSON-конвертом с машинным кодом.
      assert.equal(last.body?.error?.code, 'RATE_LIMITED');
      assert.equal(last.body.error.retryable, true);
      assert.match(last.body.error.requestId, /^req_/);
    } finally {
      await ctx.close();
    }
  });

  it('отмена не делит бюджет с созданием рендера', async () => {
    // Пользователь, исчерпавший лимит на /render, обязан суметь отменить
    // задачу — иначе платная работа продолжается против его воли.
    const ctx = await startApp({}, { render: 1, cancel: 20 });
    try {
      const created = await post(ctx.baseUrl, '/render', renderBody({ projectId: 'proj_rl2' }));
      assert.equal(created.status, 202);

      const blocked = await post(ctx.baseUrl, '/render', renderBody({ projectId: 'proj_rl3' }));
      assert.equal(blocked.status, 429, 'бюджет /render должен быть исчерпан');

      const cancelled = await post(ctx.baseUrl, `/jobs/${created.body.jobId}/cancel`);
      assert.equal(cancelled.status, 200, 'отмена не должна блокироваться лимитом /render');
      assert.equal(cancelled.body.status, 'cancelled');
    } finally {
      await ctx.close();
    }
  });
});

describe('зависший worker', () => {
  let ctx;
  before(async () => {
    // Таймаут heartbeat — 50 мс: задача «зависает» почти сразу.
    ctx = await startApp({ heartbeatTimeoutMs: 50 });
  });
  after(() => ctx.close());

  it('переводится в failed с WORKER_TIMEOUT', async () => {
    const created = await post(ctx.baseUrl, '/render', renderBody({ projectId: 'proj_stale' }));
    await new Promise((r) => setTimeout(r, 80));

    const state = await get(ctx.baseUrl, `/jobs/${created.body.jobId}`);
    assert.equal(state.body.status, 'failed');
    assert.equal(state.body.error.code, 'WORKER_TIMEOUT');
    assert.equal(state.body.error.retryable, true);
  });
});
