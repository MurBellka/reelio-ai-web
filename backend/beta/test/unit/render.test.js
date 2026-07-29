// Integration Iteration 4B: полный render API v2 в beta backend.
//
// Проверяется на фейковых адаптерах (подпись URL, запуск Job) без облака:
//   • пути строит сервер из uid/projectId; чужой путь отвергается;
//   • запускается ИСКЛЮЧИТЕЛЬНО reelio-ffmpeg-worker-v2 (не worker v1);
//   • идемпотентность, отмена, expiresAt в Store;
//   • прогресс принимает только внутренний endpoint с токеном worker'а;
//   • download отдаёт короткоживущую ссылку, просроченный результат — 410.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { startServer } from '../helpers/harness.js';

function fakeSigner() {
  const written = [];
  return {
    written,
    async uploadUrl({ bucket, objectPath, contentType, ttlSeconds }) {
      return {
        url: `https://signed.example/put/${bucket}/${objectPath}`,
        headers: { 'Content-Type': contentType },
        expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      };
    },
    async downloadUrl({ bucket, objectPath, ttlSeconds, fileName }) {
      return {
        url: `https://signed.example/get/${bucket}/${objectPath}?name=${encodeURIComponent(fileName)}`,
        expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      };
    },
    async writeJson({ objectPath, data }) {
      written.push({ objectPath, data });
    },
  };
}

function fakeJobs() {
  const launches = [];
  const cancels = [];
  return {
    launches,
    cancels,
    async launch({ jobName, region, env }) {
      launches.push({ jobName, region, env });
      return { execution: `projects/p/locations/${region}/jobs/${jobName}/executions/exec-1` };
    },
    async cancel({ execution }) {
      cancels.push(execution);
    },
  };
}

function renderConfig(overrides = {}) {
  return {
    storage: { bucket: 'reelio-render-eu', signedUrlTtlSeconds: 900, localRoot: '' },
    render: {
      workerJobName: overrides.workerJobName ?? 'reelio-ffmpeg-worker-v2',
      workerJobRegion: 'europe-west1',
      projectId: 'gemini-503615',
      workerToken: 'worker-secret',
      publicBaseUrl: 'https://beta.example',
      resultTtlDays: overrides.resultTtlDays ?? 7,
      maxActivePerUser: 1,
    },
  };
}

const PLAN = {
  id: 'plan_1',
  style: 'dynamicStyle',
  durationSeconds: 8,
  audio: { keepOriginal: true },
  captions: { enabled: true, language: 'ru', style: 'bold' },
  textOverlays: [{ id: 't1', text: 'Привет', position: { anchor: 'top', x: 0.5, y: 0.18 } }],
  clips: [{ id: 'c1', mediaId: 'asset_1', type: 'video', duration: 8, transition: 'dissolve', start: 0, end: 8 }],
};

function ownedAssets(uid = 'user_1', projectId = 'proj_r') {
  return [{ id: 'asset_1', type: 'video', objectPath: `users/${uid}/projects/${projectId}/sources/asset_1.mp4` }];
}

async function serverWith(overrides = {}) {
  const signer = fakeSigner();
  const jobs = fakeJobs();
  const harness = await startServer({
    config: renderConfig(overrides),
    render: { signer, jobs },
    now: overrides.now,
  });
  return { harness, signer, jobs };
}

test('POST /uploads строит пути сервером из uid/projectId, игнорируя клиентский', async () => {
  const { harness } = await serverWith();
  try {
    const res = await harness.request('POST', '/uploads', {
      body: {
        projectId: 'proj_r',
        assets: [
          // Клиент присылает ЧУЖОЙ objectPath — сервер его не использует.
          { id: 'asset_1', type: 'video', contentType: 'video/mp4', objectPath: 'users/hacker/x.mp4' },
        ],
      },
    });
    assert.equal(res.status, 200);
    const t = res.body.uploads[0];
    assert.equal(t.assetId, 'asset_1');
    assert.equal(t.objectPath, 'users/user_1/projects/proj_r/sources/asset_1.mp4');
    assert.equal(t.method, 'PUT');
    assert.match(t.uploadUrl, /^https:\/\/signed\.example\/put\//);
    assert.ok(t.expiresAt);
  } finally {
    await harness.close();
  }
});

test('POST /render запускает ИСКЛЮЧИТЕЛЬНО worker-v2 и кладёт план в бакет', async () => {
  const { harness, signer, jobs } = await serverWith();
  try {
    const res = await harness.request('POST', '/render', {
      body: { projectId: 'proj_r', plan: PLAN, assets: ownedAssets() },
    });
    assert.equal(res.status, 202);
    assert.equal(res.body.status, 'queued');
    assert.equal(res.body.contractVersion, 2);

    assert.equal(jobs.launches.length, 1);
    const launch = jobs.launches[0];
    assert.equal(launch.jobName, 'reelio-ffmpeg-worker-v2', 'только v2');
    assert.equal(launch.env.REELIO_CONTRACT_VERSION, '2');
    assert.match(launch.env.REELIO_PLAN_URI, /^gs:\/\/reelio-render-eu\/users\/user_1\/projects\/proj_r\/jobs\/.+\/plan\.json$/);
    assert.match(launch.env.REELIO_PROGRESS_URL, /\/internal\/render\/jobs\/.+\/progress$/);

    // План физически положен в бакет по серверному пути, ВМЕСТЕ с assets
    // (иначе worker-v2 не найдёт исходники).
    assert.equal(signer.written.length, 1);
    assert.match(signer.written[0].objectPath, /\/plan\.json$/);
    assert.equal(signer.written[0].data.contractVersion, 2);
    assert.ok(Array.isArray(signer.written[0].data.assets), 'план несёт assets');
    assert.equal(signer.written[0].data.assets[0].objectPath, ownedAssets()[0].objectPath);
    assert.ok(signer.written[0].data.plan.clips.length > 0);
  } finally {
    await harness.close();
  }
});

test('v1-имя worker отвергается — EditPlan v2 в worker v1 не уходит', async () => {
  const { harness, jobs } = await serverWith({ workerJobName: 'reelio-ffmpeg-worker' });
  try {
    const res = await harness.request('POST', '/render', {
      body: { projectId: 'proj_r', plan: PLAN, assets: ownedAssets() },
    });
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'RENDER_NOT_CONFIGURED');
    assert.equal(jobs.launches.length, 0, 'worker v1 не запускался');
  } finally {
    await harness.close();
  }
});

test('чужой objectPath в /render отвергается', async () => {
  const { harness, jobs } = await serverWith();
  try {
    const res = await harness.request('POST', '/render', {
      body: {
        projectId: 'proj_r',
        plan: PLAN,
        assets: [{ id: 'asset_1', type: 'video', objectPath: 'users/user_2/projects/proj_r/sources/asset_1.mp4' }],
      },
    });
    assert.equal(res.status, 403);
    assert.equal(jobs.launches.length, 0);
  } finally {
    await harness.close();
  }
});

test('идемпотентность: тот же ключ — та же задача, запуск один раз', async () => {
  const { harness, jobs } = await serverWith();
  try {
    const headers = { 'Idempotency-Key': 'render-key-1' };
    const first = await harness.request('POST', '/render', {
      body: { projectId: 'proj_r', plan: PLAN, assets: ownedAssets() },
      headers,
    });
    const second = await harness.request('POST', '/render', {
      body: { projectId: 'proj_r', plan: PLAN, assets: ownedAssets() },
      headers,
    });
    assert.equal(first.body.jobId, second.body.jobId);
    assert.equal(second.status, 200, 'повтор — 200, не новая задача');
    assert.equal(jobs.launches.length, 1, 'worker запущен один раз');
  } finally {
    await harness.close();
  }
});

test('прогресс: только с токеном worker; succeeded даёт download', async () => {
  const { harness } = await serverWith();
  try {
    const created = await harness.request('POST', '/render', {
      body: { projectId: 'proj_r', plan: PLAN, assets: ownedAssets() },
    });
    const jobId = created.body.jobId;

    const progressPath = `/internal/render/jobs/${jobId}/progress`;

    // Без токена — 401.
    const noAuth = await harness.request('POST', progressPath, {
      uid: null,
      appCheck: null,
      body: { phase: 'rendering', fraction: 0.5 },
    });
    assert.equal(noAuth.status, 401);

    // Неверный токен — 401.
    const badAuth = await harness.request('POST', progressPath, {
      uid: null,
      appCheck: null,
      headers: { Authorization: 'Bearer wrong' },
      body: { phase: 'rendering', fraction: 0.5 },
    });
    assert.equal(badAuth.status, 401);

    // Верный токен — прогресс принят. Статус выводит backend по фазе.
    const running = await harness.request('POST', progressPath, {
      uid: null,
      appCheck: null,
      headers: { Authorization: 'Bearer worker-secret' },
      body: { phase: 'rendering', fraction: 0.5 },
    });
    assert.equal(running.status, 200);

    const job = await harness.request('GET', `/jobs/${jobId}`);
    assert.equal(job.body.status, 'running');
    assert.ok(job.body.progress > 0.3);

    // Успех с результатом (worker шлёт phase:done + result).
    await harness.request('POST', progressPath, {
      uid: null,
      appCheck: null,
      headers: { Authorization: 'Bearer worker-secret' },
      body: {
        phase: 'done',
        fraction: 1,
        result: { sizeBytes: 123456, durationSeconds: 8, width: 1080, height: 1920, fps: 30 },
      },
    });

    const dl = await harness.request('GET', `/download?jobId=${jobId}`);
    assert.equal(dl.status, 200);
    assert.equal(dl.body.fileName, 'reelio_1920p.mp4');
    assert.equal(dl.body.sizeBytes, 123456);
    assert.match(dl.body.downloadUrl, /^https:\/\/signed\.example\/get\/.+\/output\/reel\.mp4/);
  } finally {
    await harness.close();
  }
});

test('отмена: терминальная задача — 409; активная становится cancelled', async () => {
  const { harness, jobs } = await serverWith();
  try {
    const created = await harness.request('POST', '/render', {
      body: { projectId: 'proj_r', plan: PLAN, assets: ownedAssets() },
    });
    const jobId = created.body.jobId;

    const cancelled = await harness.request('POST', `/jobs/${jobId}/cancel`);
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, 'cancelled');
    assert.equal(cancelled.body.cancelRequested, true);
    assert.equal(jobs.cancels.length, 1, 'исполнение Job отменено');

    // Повторная отмена терминальной — 409.
    const again = await harness.request('POST', `/jobs/${jobId}/cancel`);
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'JOB_ALREADY_TERMINAL');
  } finally {
    await harness.close();
  }
});

test('просроченный результат — 410 RESULT_EXPIRED', async () => {
  let clock = new Date('2026-03-01T00:00:00Z');
  const { harness } = await serverWith({ resultTtlDays: 1, now: () => clock });
  try {
    const created = await harness.request('POST', '/render', {
      body: { projectId: 'proj_r', plan: PLAN, assets: ownedAssets() },
    });
    const jobId = created.body.jobId;
    await harness.request('POST', `/internal/render/jobs/${jobId}/progress`, {
      uid: null,
      appCheck: null,
      headers: { Authorization: 'Bearer worker-secret' },
      body: { phase: 'done', fraction: 1, result: { height: 1920 } },
    });

    // Перематываем время за expiresAt (ttl 1 день).
    clock = new Date('2026-03-05T00:00:00Z');
    const dl = await harness.request('GET', `/download?jobId=${jobId}`);
    assert.equal(dl.status, 410);
    assert.equal(dl.body.error.code, 'RESULT_EXPIRED');
  } finally {
    await harness.close();
  }
});

test('чужую задачу рендера не видно (одинаковый 404)', async () => {
  const { harness } = await serverWith();
  try {
    const created = await harness.request('POST', '/render', {
      body: { projectId: 'proj_r', plan: PLAN, assets: ownedAssets() },
    });
    const jobId = created.body.jobId;
    const foreign = await harness.request('GET', `/jobs/${jobId}`, { uid: 'user_2' });
    assert.equal(foreign.status, 404);
    assert.equal(foreign.body.error.code, 'JOB_NOT_FOUND');
  } finally {
    await harness.close();
  }
});
