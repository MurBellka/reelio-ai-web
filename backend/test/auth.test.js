// Тесты безопасности публичной беты: аутентификация, App Check, изоляция
// пользователей, квоты и удаление данных.
//
// Всё в local mode — без Firebase и без облачных ресурсов. Верификатор
// подменяется, но проверяемая логика (middleware, владение, транзакции квот)
// — ровно та же, что работает в облаке.

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { createApp } from '../src/app.js';

const WORKER_TOKEN = 'test-worker-token';
const UID = 'alice';
const OTHER = 'bob';

function fakeVerifier() {
  const deleted = [];
  return {
    deleted,
    async verifyIdToken(token) {
      if (token === 'expired') throw new Error('token expired');
      if (token === 'forged') throw new Error('signature mismatch');
      if (!token.includes(':')) throw new Error('malformed');
      const [uid, state] = token.split(':');
      return { uid, email: `${uid}@example.com`, emailVerified: state === 'verified' };
    },
    async verifyAppCheckToken(token) {
      if (token !== 'appcheck-ok') throw new Error('invalid app check token');
      return { appId: 'test-app' };
    },
    async deleteUser(uid) {
      deleted.push(uid);
    },
  };
}

function baseConfig(root, { appCheckMode = 'off', limits = {}, verifier } = {}) {
  return {
    port: 0,
    gemini: { apiKey: '', model: 'gemini-2.5-flash' },
    rateLimits: { editPlan: 1000, render: 1000, cancel: 1000, poll: 1000 },
    firebase: { projectId: 'test-project' },
    auth: { verifier, disabled: false },
    appCheck: { mode: appCheckMode },
    limits: {
      userDailyCredits: 4,
      globalDailyCredits: 40,
      ipDailyCredits: 8,
      maxActiveJobsPerUser: 50,
      maxActiveJobsGlobal: 100,
      editPlanDaily: 10,
      maxVideos: 20,
      maxPhotos: 20,
      maxSingleVideoSeconds: 600,
      maxProjectVideoSeconds: 3600,
      maxProjectBytes: 2 * 1024 * 1024 * 1024,
      maxOutputSeconds: 120,
      ...limits,
    },
    allowedOrigins: new Set(['http://localhost:5353']),
    render: {
      mode: 'local',
      bucket: '',
      gcpProject: '',
      firestoreDatabase: '(default)',
      jobName: '',
      jobRegion: 'europe-west1',
      signedUrlTtlSeconds: 900,
      jobTtlDays: 7,
      heartbeatTimeoutMs: 600_000,
      localRoot: root,
      localWorkerCmd: '',
      publicBaseUrl: '',
      workerToken: WORKER_TOKEN,
    },
  };
}

async function startApp(opts = {}) {
  const root = await mkdtemp(join(tmpdir(), 'reelio-auth-'));
  const verifier = opts.verifier || fakeVerifier();
  const config = baseConfig(root, { ...opts, verifier });
  const app = await createApp(config);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  config.render.publicBaseUrl = baseUrl;
  app.locals.storage.baseUrl = baseUrl;
  return {
    baseUrl,
    app,
    verifier,
    async close() {
      await new Promise((r) => server.close(r));
      await rm(root, { recursive: true, force: true });
    },
  };
}

const headers = (token, appCheck = 'appcheck-ok') => ({
  'Content-Type': 'application/json',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
  ...(appCheck ? { 'X-Firebase-AppCheck': appCheck } : {}),
});

async function call(baseUrl, method, path, { token, appCheck = 'appcheck-ok', body } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: headers(token, appCheck),
    // GET/HEAD не могут нести тело — fetch бросает TypeError.
    ...(body && method !== 'GET' && method !== 'HEAD' ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function renderBody(uid, projectId = 'proj1', overrides = {}) {
  return {
    contractVersion: 1,
    projectId,
    assets: [
      {
        id: 'asset_a',
        type: 'video',
        objectPath: `users/${uid}/projects/${projectId}/sources/asset_a.mp4`,
        durationSeconds: 40,
        width: 1080,
        height: 1920,
      },
    ],
    plan: {
      id: 'plan_1',
      style: 'dynamicStyle',
      durationSeconds: 8,
      captions: { enabled: true, language: 'ru', style: 'bold', colorHex: '#FFFFFF' },
      music: { track: 'chill', volume: 0.7 },
      clips: [
        { id: 'c1', mediaId: 'asset_a', type: 'video', duration: 8, start: 0, end: 8, transition: 'cut' },
      ],
    },
    export: { resolution: 'fullHd1080', fps: 30 },
    ...overrides,
  };
}

/** Маршруты, которые обязаны требовать вход. */
const PROTECTED = [
  ['POST', '/edit-plan'],
  ['POST', '/uploads'],
  ['POST', '/render'],
  ['GET', '/jobs/job_x'],
  ['POST', '/jobs/job_x/cancel'],
  ['GET', '/download?jobId=job_x'],
  ['GET', '/me'],
  ['DELETE', '/projects/proj1'],
  ['DELETE', '/account'],
];

describe('аутентификация', () => {
  it('без токена все защищённые маршруты дают 401', async () => {
    const ctx = await startApp();
    try {
      for (const [method, path] of PROTECTED) {
        const res = await call(ctx.baseUrl, method, path, { token: null, body: {} });
        assert.equal(res.status, 401, `${method} ${path} должен требовать вход`);
        assert.equal(res.body?.error?.code, 'UNAUTHENTICATED');
      }
    } finally {
      await ctx.close();
    }
  });

  it('/health остаётся публичным', async () => {
    const ctx = await startApp();
    try {
      const res = await call(ctx.baseUrl, 'GET', '/health', { token: null, appCheck: null });
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
    } finally {
      await ctx.close();
    }
  });

  it('неподтверждённая почта отклоняется отдельным кодом', async () => {
    const ctx = await startApp();
    try {
      const res = await call(ctx.baseUrl, 'POST', '/render', {
        token: `${UID}:unverified`,
        body: renderBody(UID),
      });
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'EMAIL_NOT_VERIFIED');
      // Сообщение обязано подсказывать, что делать.
      assert.match(res.body.error.message, /[Пп]одтвердите/);
    } finally {
      await ctx.close();
    }
  });

  it('истёкший и поддельный токен неразличимы для клиента', async () => {
    const ctx = await startApp();
    try {
      const expired = await call(ctx.baseUrl, 'GET', '/me', { token: 'expired' });
      const forged = await call(ctx.baseUrl, 'GET', '/me', { token: 'forged' });

      assert.equal(expired.status, 401);
      assert.equal(forged.status, 401);
      // Одинаковый код И одинаковый текст: причина провала — не информация
      // для клиента, иначе токены можно перебирать по разнице ответов.
      assert.equal(expired.body.error.code, forged.body.error.code);
      assert.equal(expired.body.error.message, forged.body.error.message);
    } finally {
      await ctx.close();
    }
  });

  it('uid берётся из токена, а не из тела запроса', async () => {
    const ctx = await startApp();
    try {
      // Пытаемся выдать себя за другого через поля тела.
      const body = renderBody(UID);
      body.ownerUid = OTHER;
      body.uid = OTHER;

      const res = await call(ctx.baseUrl, 'POST', '/render', { token: `${UID}:verified`, body });
      assert.equal(res.status, 202);

      const job = await ctx.app.locals.service.getJob(res.body.jobId, UID);
      assert.equal(job.ownerUid, UID, 'владельцем обязан стать владелец токена');
    } finally {
      await ctx.close();
    }
  });
});

describe('App Check', () => {
  it('в режиме monitor не блокирует запрос без токена', async () => {
    const ctx = await startApp({ appCheckMode: 'monitor' });
    try {
      const res = await call(ctx.baseUrl, 'GET', '/me', { token: `${UID}:verified`, appCheck: null });
      assert.equal(res.status, 200, 'monitor обязан пропускать: это режим наблюдения');
    } finally {
      await ctx.close();
    }
  });

  it('в режиме enforce отклоняет неправильный токен', async () => {
    const ctx = await startApp({ appCheckMode: 'enforce' });
    try {
      const bad = await call(ctx.baseUrl, 'GET', '/me', {
        token: `${UID}:verified`,
        appCheck: 'not-a-real-token',
      });
      assert.equal(bad.status, 403);
      assert.equal(bad.body.error.code, 'APP_CHECK_FAILED');

      const missing = await call(ctx.baseUrl, 'GET', '/me', {
        token: `${UID}:verified`,
        appCheck: null,
      });
      assert.equal(missing.status, 403);
      assert.equal(missing.body.error.code, 'APP_CHECK_FAILED');
    } finally {
      await ctx.close();
    }
  });

  it('в режиме enforce пропускает верный токен', async () => {
    const ctx = await startApp({ appCheckMode: 'enforce' });
    try {
      const res = await call(ctx.baseUrl, 'GET', '/me', { token: `${UID}:verified` });
      assert.equal(res.status, 200);
    } finally {
      await ctx.close();
    }
  });

  it('App Check и Auth проверяются независимо', async () => {
    const ctx = await startApp({ appCheckMode: 'enforce' });
    try {
      // Верный App Check, но нет входа → ошибка про вход, а не про приложение.
      const noAuth = await call(ctx.baseUrl, 'GET', '/me', { token: null });
      assert.equal(noAuth.body.error.code, 'UNAUTHENTICATED');

      // Верный вход, но плохой App Check → ошибка про приложение.
      const noCheck = await call(ctx.baseUrl, 'GET', '/me', {
        token: `${UID}:verified`,
        appCheck: 'bad',
      });
      assert.equal(noCheck.body.error.code, 'APP_CHECK_FAILED');
    } finally {
      await ctx.close();
    }
  });
});

describe('изоляция пользователей', () => {
  it('чужая задача неотличима от несуществующей', async () => {
    const ctx = await startApp();
    try {
      const mine = await call(ctx.baseUrl, 'POST', '/render', {
        token: `${UID}:verified`,
        body: renderBody(UID),
      });
      assert.equal(mine.status, 202);
      const jobId = mine.body.jobId;

      const foreign = await call(ctx.baseUrl, 'GET', `/jobs/${jobId}`, { token: `${OTHER}:verified` });
      const missing = await call(ctx.baseUrl, 'GET', '/jobs/job_01NOSUCHJOB', {
        token: `${OTHER}:verified`,
      });

      assert.equal(foreign.status, 404);
      assert.equal(missing.status, 404);
      // Ответы обязаны совпадать полностью: иначе перебором jobId можно
      // выяснить, какие задачи существуют у других пользователей.
      assert.equal(foreign.body.error.code, missing.body.error.code);
      assert.equal(foreign.body.error.message, missing.body.error.message);
    } finally {
      await ctx.close();
    }
  });

  it('чужую задачу нельзя отменить или скачать', async () => {
    const ctx = await startApp();
    try {
      const mine = await call(ctx.baseUrl, 'POST', '/render', {
        token: `${UID}:verified`,
        body: renderBody(UID),
      });
      const jobId = mine.body.jobId;

      const cancel = await call(ctx.baseUrl, 'POST', `/jobs/${jobId}/cancel`, {
        token: `${OTHER}:verified`,
      });
      assert.equal(cancel.status, 404);
      assert.equal(cancel.body.error.code, 'JOB_NOT_FOUND');

      const download = await call(ctx.baseUrl, 'GET', `/download?jobId=${jobId}`, {
        token: `${OTHER}:verified`,
      });
      assert.equal(download.status, 404);

      // Задача обязана остаться нетронутой.
      const still = await call(ctx.baseUrl, 'GET', `/jobs/${jobId}`, { token: `${UID}:verified` });
      assert.equal(still.status, 200);
      assert.notEqual(still.body.status, 'cancelled');
    } finally {
      await ctx.close();
    }
  });

  it('нельзя запросить загрузку в чужой каталог', async () => {
    const ctx = await startApp();
    try {
      const res = await call(ctx.baseUrl, 'POST', '/uploads', {
        token: `${UID}:verified`,
        body: {
          contractVersion: 1,
          projectId: 'proj1',
          assets: [
            {
              id: 'asset_a',
              type: 'video',
              objectPath: `users/${OTHER}/projects/proj1/sources/asset_a.mp4`,
              contentType: 'video/mp4',
            },
          ],
        },
      });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'INVALID_OBJECT_PATH');
    } finally {
      await ctx.close();
    }
  });

  it('нельзя отрендерить план, ссылающийся на чужие исходники', async () => {
    const ctx = await startApp();
    try {
      const body = renderBody(UID);
      body.assets[0].objectPath = `users/${OTHER}/projects/proj1/sources/asset_a.mp4`;
      const res = await call(ctx.baseUrl, 'POST', '/render', { token: `${UID}:verified`, body });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'INVALID_OBJECT_PATH');
    } finally {
      await ctx.close();
    }
  });

  it('одинаковый план разных пользователей — разные задачи', async () => {
    const ctx = await startApp();
    try {
      const a = await call(ctx.baseUrl, 'POST', '/render', {
        token: `${UID}:verified`,
        body: renderBody(UID),
      });
      const b = await call(ctx.baseUrl, 'POST', '/render', {
        token: `${OTHER}:verified`,
        body: renderBody(OTHER),
      });
      assert.equal(a.status, 202);
      assert.equal(b.status, 202);
      assert.notEqual(a.body.jobId, b.body.jobId, 'идемпотентность не должна склеивать пользователей');
    } finally {
      await ctx.close();
    }
  });
});

describe('квоты', () => {
  it('дневной лимит кредитов исчерпывается и сообщает об этом', async () => {
    const ctx = await startApp({ limits: { userDailyCredits: 2 } });
    try {
      for (let i = 0; i < 2; i += 1) {
        const ok = await call(ctx.baseUrl, 'POST', '/render', {
          token: `${UID}:verified`,
          body: renderBody(UID, `p${i}`),
        });
        assert.equal(ok.status, 202, `рендер ${i + 1} должен пройти`);
      }
      const denied = await call(ctx.baseUrl, 'POST', '/render', {
        token: `${UID}:verified`,
        body: renderBody(UID, 'p_over'),
      });
      assert.equal(denied.status, 429);
      assert.equal(denied.body.error.code, 'DAILY_LIMIT_REACHED');
    } finally {
      await ctx.close();
    }
  });

  it('стоимость зависит от разрешения: 4K дороже 720p', async () => {
    const ctx = await startApp({ limits: { userDailyCredits: 4 } });
    try {
      // 4K стоит 4 кредита — сразу исчерпывает сутки.
      const fourK = await call(ctx.baseUrl, 'POST', '/render', {
        token: `${UID}:verified`,
        body: renderBody(UID, 'p4k', { export: { resolution: 'fourK2160', fps: 30 } }),
      });
      assert.equal(fourK.status, 202);

      const next = await call(ctx.baseUrl, 'POST', '/render', {
        token: `${UID}:verified`,
        body: renderBody(UID, 'p720', { export: { resolution: 'hd720', fps: 30 } }),
      });
      assert.equal(next.status, 429, 'после 4K кредитов остаться не должно');
    } finally {
      await ctx.close();
    }
  });

  it('глобальный лимит даёт GLOBAL_DAILY_LIMIT_REACHED', async () => {
    const ctx = await startApp({ limits: { globalDailyCredits: 1, userDailyCredits: 10 } });
    try {
      const first = await call(ctx.baseUrl, 'POST', '/render', {
        token: `${UID}:verified`,
        body: renderBody(UID),
      });
      assert.equal(first.status, 202);

      // Другой пользователь упирается в общий потолок сервиса.
      const second = await call(ctx.baseUrl, 'POST', '/render', {
        token: `${OTHER}:verified`,
        body: renderBody(OTHER),
      });
      assert.equal(second.status, 429);
      assert.equal(second.body.error.code, 'GLOBAL_DAILY_LIMIT_REACHED');
      assert.equal(second.body.error.retryable, true);
    } finally {
      await ctx.close();
    }
  });

  it('параллельные запросы не обходят квоту', async () => {
    const ctx = await startApp({ limits: { userDailyCredits: 3 } });
    try {
      // Десять одновременных рендеров при квоте 3: пройти обязаны ровно 3.
      const attempts = Array.from({ length: 10 }, (_, i) =>
        call(ctx.baseUrl, 'POST', '/render', {
          token: `${UID}:verified`,
          body: renderBody(UID, `race${i}`),
        }),
      );
      const results = await Promise.all(attempts);
      const accepted = results.filter((r) => r.status === 202).length;
      const denied = results.filter((r) => r.status === 429).length;

      assert.equal(accepted, 3, `квота 3, а прошло ${accepted} — счётчик не атомарен`);
      assert.equal(accepted + denied, 10);
    } finally {
      await ctx.close();
    }
  });

  it('отмена возвращает кредит', async () => {
    const ctx = await startApp({ limits: { userDailyCredits: 1 } });
    try {
      const first = await call(ctx.baseUrl, 'POST', '/render', {
        token: `${UID}:verified`,
        body: renderBody(UID, 'c1'),
      });
      assert.equal(first.status, 202);

      // Кредит израсходован.
      const blocked = await call(ctx.baseUrl, 'POST', '/render', {
        token: `${UID}:verified`,
        body: renderBody(UID, 'c2'),
      });
      assert.equal(blocked.status, 429);

      await call(ctx.baseUrl, 'POST', `/jobs/${first.body.jobId}/cancel`, {
        token: `${UID}:verified`,
      });

      // После отмены кредит обязан вернуться.
      const retry = await call(ctx.baseUrl, 'POST', '/render', {
        token: `${UID}:verified`,
        body: renderBody(UID, 'c2'),
      });
      assert.equal(retry.status, 202, 'отменённая задача не должна расходовать квоту');
    } finally {
      await ctx.close();
    }
  });

  it('квота одного пользователя не влияет на другого', async () => {
    const ctx = await startApp({ limits: { userDailyCredits: 1, globalDailyCredits: 40 } });
    try {
      await call(ctx.baseUrl, 'POST', '/render', { token: `${UID}:verified`, body: renderBody(UID) });
      const mineBlocked = await call(ctx.baseUrl, 'POST', '/render', {
        token: `${UID}:verified`,
        body: renderBody(UID, 'p2'),
      });
      assert.equal(mineBlocked.status, 429);

      const theirs = await call(ctx.baseUrl, 'POST', '/render', {
        token: `${OTHER}:verified`,
        body: renderBody(OTHER),
      });
      assert.equal(theirs.status, 202);
    } finally {
      await ctx.close();
    }
  });

  it('/me показывает остаток кредитов и стоимость разрешений', async () => {
    const ctx = await startApp({ limits: { userDailyCredits: 4 } });
    try {
      const before = await call(ctx.baseUrl, 'GET', '/me', { token: `${UID}:verified` });
      assert.equal(before.status, 200);
      assert.equal(before.body.uid, UID);
      assert.equal(before.body.usage.renderCreditsRemaining, 4);
      assert.equal(before.body.usage.costs.fourK2160, 4);
      assert.equal(before.body.limits.maxOutputSeconds, 120);

      await call(ctx.baseUrl, 'POST', '/render', { token: `${UID}:verified`, body: renderBody(UID) });

      const after = await call(ctx.baseUrl, 'GET', '/me', { token: `${UID}:verified` });
      assert.equal(after.body.usage.renderCreditsRemaining, 3);
    } finally {
      await ctx.close();
    }
  });
});

describe('удаление данных', () => {
  async function seedProject(ctx, uid, projectId) {
    const created = await call(ctx.baseUrl, 'POST', '/render', {
      token: `${uid}:verified`,
      body: renderBody(uid, projectId),
    });
    assert.equal(created.status, 202);
    // Кладём файл исходника, чтобы проверить реальное удаление объектов.
    const objectPath = `users/${uid}/projects/${projectId}/sources/asset_a.mp4`;
    const full = ctx.app.locals.storage.localFilePath(objectPath);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, 'bytes');
    return created.body.jobId;
  }

  it('удаление проекта убирает объекты и задачи', async () => {
    const ctx = await startApp();
    try {
      const jobId = await seedProject(ctx, UID, 'del1');

      const res = await call(ctx.baseUrl, 'DELETE', '/projects/del1', { token: `${UID}:verified` });
      assert.equal(res.status, 200);
      assert.equal(res.body.deleted, true);
      assert.ok(res.body.objects > 0, 'должны удалиться реальные объекты');

      const gone = await call(ctx.baseUrl, 'GET', `/jobs/${jobId}`, { token: `${UID}:verified` });
      assert.equal(gone.status, 404);
      assert.equal(
        await ctx.app.locals.storage.exists(`users/${UID}/projects/del1/sources/asset_a.mp4`),
        false,
      );
    } finally {
      await ctx.close();
    }
  });

  it('нельзя удалить чужой проект', async () => {
    const ctx = await startApp();
    try {
      await seedProject(ctx, UID, 'mine');
      const res = await call(ctx.baseUrl, 'DELETE', '/projects/mine', { token: `${OTHER}:verified` });
      assert.equal(res.status, 200, 'ответ не должен раскрывать существование чужого проекта');
      assert.equal(res.body.objects, 0, 'но удалить чужие данные не должно');

      // Данные владельца на месте.
      assert.equal(
        await ctx.app.locals.storage.exists(`users/${UID}/projects/mine/sources/asset_a.mp4`),
        true,
      );
    } finally {
      await ctx.close();
    }
  });

  it('удаление аккаунта чистит данные и учётную запись', async () => {
    const ctx = await startApp();
    try {
      await seedProject(ctx, UID, 'a1');
      await seedProject(ctx, UID, 'a2');
      await seedProject(ctx, OTHER, 'theirs');

      const res = await call(ctx.baseUrl, 'DELETE', '/account', { token: `${UID}:verified` });
      assert.equal(res.status, 200);
      assert.equal(res.body.deleted, true);
      assert.ok(res.body.jobs >= 2);
      assert.ok(res.body.objects >= 2);

      assert.deepEqual(ctx.verifier.deleted, [UID], 'учётная запись должна удаляться');
      assert.equal(await ctx.app.locals.storage.exists(`users/${UID}/projects/a1/sources/asset_a.mp4`), false);
      // Чужие данные не тронуты.
      assert.equal(
        await ctx.app.locals.storage.exists(`users/${OTHER}/projects/theirs/sources/asset_a.mp4`),
        true,
      );
    } finally {
      await ctx.close();
    }
  });

  it('после удаления аккаунта квоты пользователя обнуляются', async () => {
    const ctx = await startApp({ limits: { userDailyCredits: 1 } });
    try {
      await call(ctx.baseUrl, 'POST', '/render', { token: `${UID}:verified`, body: renderBody(UID) });
      const blocked = await call(ctx.baseUrl, 'POST', '/render', {
        token: `${UID}:verified`,
        body: renderBody(UID, 'p2'),
      });
      assert.equal(blocked.status, 429);

      const res = await call(ctx.baseUrl, 'DELETE', '/account', { token: `${UID}:verified` });
      assert.ok(res.body.quotaDocs >= 1, 'счётчики квот должны удаляться вместе с аккаунтом');
    } finally {
      await ctx.close();
    }
  });
});

describe('канал worker не сломан авторизацией', () => {
  it('worker отчитывается своим токеном, без Firebase', async () => {
    const ctx = await startApp();
    try {
      const created = await call(ctx.baseUrl, 'POST', '/render', {
        token: `${UID}:verified`,
        body: renderBody(UID),
      });
      const jobId = created.body.jobId;

      // Ни Firebase-токена, ни App Check — только общий секрет worker'а.
      const res = await fetch(`${ctx.baseUrl}/internal/jobs/${jobId}/progress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WORKER_TOKEN}` },
        body: JSON.stringify({ phase: 'preparing', fraction: 1 }),
      });
      assert.equal(res.status, 200, 'канал worker→backend не должен требовать Firebase');

      const state = await call(ctx.baseUrl, 'GET', `/jobs/${jobId}`, { token: `${UID}:verified` });
      assert.equal(state.body.phase, 'preparing');
    } finally {
      await ctx.close();
    }
  });

  it('Firebase-токен не открывает внутренний канал', async () => {
    const ctx = await startApp();
    try {
      const created = await call(ctx.baseUrl, 'POST', '/render', {
        token: `${UID}:verified`,
        body: renderBody(UID),
      });
      const res = await fetch(`${ctx.baseUrl}/internal/jobs/${created.body.jobId}/progress`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${UID}:verified` },
        body: JSON.stringify({ phase: 'done' }),
      });
      assert.equal(res.status, 401, 'пользовательский токен не должен управлять прогрессом');
    } finally {
      await ctx.close();
    }
  });
});
