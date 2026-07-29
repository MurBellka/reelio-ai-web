// Каноническая настройка OIDC audience для Cloud Tasks → внутренний endpoint
// (§4A.7). Регресс на дефект, найденный при beta-деплое: task ставился с
// audience, равным полному URL С ПУТЁМ, а internalGuard проверял голый service
// URL — строгая сверка google-auth-library давала FORBIDDEN на КАЖДУЮ задачу.
//
// Тесты проверяют РЕАЛЬНУЮ проводку, а не подставляют готовый успешный verifier:
//   • CloudTasksQueue стамповка target URL и audience идёт из одной конфигурации;
//   • createOidcVerifier реально дёргает OAuth2Client.verifyIdToken, и тест ловит
//     фактический аргумент `audience`, связывая его с payload Cloud Tasks;
//   • строгая валидация cloud-конфигурации не даёт стартовать на плохих URL.

import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { test } from 'node:test';

import { createApp } from '../../src/app.js';
import { createOidcVerifier } from '../../src/auth.js';
import { assertTasksConfigForMode, INTERNAL_TASK_PATH, loadConfig } from '../../src/config.js';
import { CloudTasksQueue, InlineTaskQueue, createTaskQueue } from '../../src/tasks.js';
import { fakeGemini, fakeMedia, fakeVerifier } from '../helpers/harness.js';

const STABLE_ORIGIN = 'https://reelio-backend-beta-abc123-ew.a.run.app';
const INVOKER_SA = 'reelio-tasks-invoker@proj-test.iam.gserviceaccount.com';

/** Валидная cloud-конфигурация: стабильный origin, очередь, invoker-SA. */
function cloudEnv(overrides = {}) {
  return {
    REELIO_RUNTIME: 'cloud',
    FIREBASE_PROJECT_ID: 'proj-test',
    CLOUD_TASKS_QUEUE: 'reelio-analysis-v2',
    CLOUD_TASKS_LOCATION: 'europe-west1',
    INTERNAL_BASE_URL: STABLE_ORIGIN,
    TASKS_INVOKER_SA: INVOKER_SA,
    ...overrides,
  };
}

/** Фейковый Cloud Tasks-клиент: перехватывает созданную задачу целиком. */
function fakeCloudTasksClient() {
  const created = [];
  return {
    created,
    queuePath(projectId, location, queue) {
      return `projects/${projectId}/locations/${location}/queues/${queue}`;
    },
    async createTask({ parent, task }) {
      created.push({ parent, task });
      return [{ name: `${parent}/tasks/generated` }];
    },
  };
}

/**
 * Фейковый OAuth2Client: эмулирует СТРОГУЮ проверку google-auth-library — токен
 * подписан с фиксированным `aud`, и verifyIdToken бросает, если запрошенный
 * `audience` не совпадает с `aud` токена. Перехватывает каждый вызов, чтобы
 * тест мог сверить фактический `audience` с payload Cloud Tasks.
 */
function fakeOAuth2Client({ tokenAud, email }) {
  const calls = [];
  return {
    calls,
    async verifyIdToken({ idToken, audience }) {
      calls.push({ idToken, audience });
      if (audience !== tokenAud) {
        throw new Error('Wrong recipient, payload audience != requiredAudience');
      }
      return { getPayload: () => ({ email, aud: tokenAud }) };
    },
  };
}

// ── 1 + 2: CloudTasksQueue стамповка target URL и audience ────────────────────

test('CloudTasksQueue: target URL = origin + /internal/analysis/run, audience = origin без пути', async () => {
  const config = loadConfig(cloudEnv());
  const queue = createTaskQueue(config, null);
  assert.ok(queue instanceof CloudTasksQueue, 'в cloud mode — Cloud Tasks очередь');

  const client = fakeCloudTasksClient();
  queue.client = client; // инъекция вместо реального SDK
  await queue.enqueue({ jobId: 'j1', kind: 'analysis.run', uid: 'u1' });

  const { httpRequest } = client.created[0].task;
  // (1) target URL несёт фиксированный внутренний путь.
  assert.equal(httpRequest.url, `${STABLE_ORIGIN}/internal/analysis/run`);
  assert.equal(new URL(httpRequest.url).pathname, INTERNAL_TASK_PATH);
  // (2) audience — канонический origin, БЕЗ пути.
  assert.equal(httpRequest.oidcToken.audience, STABLE_ORIGIN);
  assert.ok(!httpRequest.oidcToken.audience.includes('/internal/'), 'audience без пути');
  assert.notEqual(httpRequest.oidcToken.audience, httpRequest.url, 'audience ≠ target URL');
  assert.equal(httpRequest.oidcToken.serviceAccountEmail, INVOKER_SA);
});

// ── 3: createOidcVerifier получает тот же канонический audience ───────────────

test('createOidcVerifier передаёт в verifyIdToken канонический audience', async () => {
  const config = loadConfig(cloudEnv());
  const oauth = fakeOAuth2Client({ tokenAud: config.tasks.oidcAudience, email: INVOKER_SA });
  const verifier = await createOidcVerifier({
    ...config,
    tasks: { ...config.tasks, oauth2Client: oauth },
  });

  await verifier.verify('minted-token', config.tasks.oidcAudience);

  assert.equal(oauth.calls.length, 1, 'реально дёрнут OAuth2Client, а не заглушка');
  assert.equal(oauth.calls[0].audience, STABLE_ORIGIN);
  assert.equal(oauth.calls[0].audience, config.tasks.oidcAudience);
});

// ── 4: правильный audience + SA email принимаются ────────────────────────────

test('верный audience и SA email — успех', async () => {
  const config = loadConfig(cloudEnv());
  const oauth = fakeOAuth2Client({ tokenAud: config.tasks.oidcAudience, email: INVOKER_SA });
  const verifier = await createOidcVerifier({
    ...config,
    tasks: { ...config.tasks, oauth2Client: oauth },
  });

  const result = await verifier.verify('minted-token', config.tasks.oidcAudience);
  assert.equal(result.email, INVOKER_SA);
});

// ── 5: audience с внутренним путём отвергается ───────────────────────────────

test('audience с /internal/analysis/run отвергается (строгая сверка)', async () => {
  const config = loadConfig(cloudEnv());
  // Токен подписан на канонический origin; попытка проверить его против
  // audience-с-путём (старое ошибочное значение) должна провалиться.
  const oauth = fakeOAuth2Client({ tokenAud: config.tasks.oidcAudience, email: INVOKER_SA });
  const verifier = await createOidcVerifier({
    ...config,
    tasks: { ...config.tasks, oauth2Client: oauth },
  });

  const audienceWithPath = `${config.tasks.oidcAudience}${INTERNAL_TASK_PATH}`;
  await assert.rejects(verifier.verify('minted-token', audienceWithPath), /Wrong recipient/);
});

// ── 6: чужой audience отвергается ────────────────────────────────────────────

test('чужой audience отвергается', async () => {
  const config = loadConfig(cloudEnv());
  const oauth = fakeOAuth2Client({ tokenAud: config.tasks.oidcAudience, email: INVOKER_SA });
  const verifier = await createOidcVerifier({
    ...config,
    tasks: { ...config.tasks, oauth2Client: oauth },
  });

  await assert.rejects(verifier.verify('minted-token', 'https://evil.example.com'), /Wrong recipient/);
});

// ── 7: чужой SA email отвергается ────────────────────────────────────────────

test('чужой service-account email отвергается', async () => {
  const config = loadConfig(cloudEnv());
  // Подпись валидна для нужного audience, но email — не наш invoker-SA.
  const oauth = fakeOAuth2Client({
    tokenAud: config.tasks.oidcAudience,
    email: 'attacker@evil.iam.gserviceaccount.com',
  });
  const verifier = await createOidcVerifier({
    ...config,
    tasks: { ...config.tasks, oauth2Client: oauth },
  });

  await assert.rejects(verifier.verify('minted-token', config.tasks.oidcAudience), /unexpected caller/);
});

// ── 8: несовместимая cloud-конфигурация не запускается ───────────────────────

test('пустая/HTTP/tagged cloud-конфигурация отвергается, валидная — проходит', () => {
  // Валидная конфигурация проходит.
  assert.doesNotThrow(() => assertTasksConfigForMode(loadConfig(cloudEnv())));

  // Пустая (нет очереди/URL/SA).
  assert.throws(
    () => assertTasksConfigForMode(loadConfig({ REELIO_RUNTIME: 'cloud', FIREBASE_PROJECT_ID: 'p' })),
    /REFUSING TO START/,
  );

  // HTTP вместо HTTPS.
  assert.throws(
    () => assertTasksConfigForMode(loadConfig(cloudEnv({ INTERNAL_BASE_URL: 'http://reelio-backend-beta-abc123-ew.a.run.app' }))),
    /https/,
  );

  // Tag/canary URL Cloud Run (hostname с `---`) вместо стабильного service URL.
  assert.throws(
    () => assertTasksConfigForMode(loadConfig(cloudEnv({ INTERNAL_BASE_URL: 'https://canary---reelio-backend-beta-abc123-ew.a.run.app' }))),
    /tag\/canary/,
  );

  // Audience с путём (составлен вручную).
  assert.throws(
    () => assertTasksConfigForMode(loadConfig(cloudEnv({ INTERNAL_OIDC_AUDIENCE: `${STABLE_ORIGIN}/internal/analysis/run` }))),
    /без пути/,
  );

  // Query/fragment в URL.
  assert.throws(
    () => assertTasksConfigForMode(loadConfig(cloudEnv({ INTERNAL_BASE_URL: `${STABLE_ORIGIN}?x=1` }))),
    /query\/fragment/,
  );
});

test('нормализация снимает хвостовой «/» с origin и audience', () => {
  const config = loadConfig(cloudEnv({ INTERNAL_BASE_URL: `${STABLE_ORIGIN}/` }));
  assert.equal(config.tasks.internalUrl, STABLE_ORIGIN);
  assert.equal(config.tasks.oidcAudience, STABLE_ORIGIN);
  assert.doesNotThrow(() => assertTasksConfigForMode(config));
});

test('явный INTERNAL_OIDC_AUDIENCE переопределяет дефолт INTERNAL_BASE_URL', () => {
  const explicit = 'https://reelio-backend-beta-explicit-ew.a.run.app';
  const config = loadConfig(cloudEnv({ INTERNAL_OIDC_AUDIENCE: explicit }));
  assert.equal(config.tasks.oidcAudience, explicit);
  assert.equal(config.tasks.internalUrl, STABLE_ORIGIN, 'target origin остаётся INTERNAL_BASE_URL');
});

// ── 9: локальный режим — InlineTaskQueue без OIDC ────────────────────────────

test('local mode: InlineTaskQueue работает без OIDC-конфигурации', async () => {
  const config = loadConfig({}); // нет K_SERVICE/REELIO_RUNTIME → local
  assert.equal(config.mode, 'local');

  // Валидация OIDC в local mode пропускается.
  assert.doesNotThrow(() => assertTasksConfigForMode(config));
  // OIDC-верификатор в local mode не создаётся.
  assert.equal(await createOidcVerifier(config), null);

  const seen = [];
  const queue = createTaskQueue(config, async ({ jobId }) => {
    seen.push(jobId);
  });
  assert.ok(queue instanceof InlineTaskQueue);
  await queue.enqueue({ jobId: 'local-1', kind: 'analysis.run' });
  await queue.drain();
  assert.deepEqual(seen, ['local-1']);
});

// ── 10: полный enqueue → внутренний endpoint с согласованной конфигурацией ────

test('интеграция: audience из payload Cloud Tasks проходит внутренний endpoint приложения', async () => {
  const config = loadConfig(cloudEnv());

  // (a) Реальный enqueue → payload Cloud Tasks.
  const tqClient = fakeCloudTasksClient();
  const queue = createTaskQueue(config, null);
  queue.client = tqClient;
  await queue.enqueue({ jobId: 'job-10', kind: 'analysis.run', uid: 'u1' });
  const enqueued = tqClient.created[0].task.httpRequest;
  const taskUrl = new URL(enqueued.url);
  const taskAudience = enqueued.oidcToken.audience;

  // (b) Токен подписан Cloud Tasks именно на audience из payload.
  const oauth = fakeOAuth2Client({ tokenAud: taskAudience, email: INVOKER_SA });
  const oidcVerifier = await createOidcVerifier({
    ...config,
    tasks: { ...config.tasks, oauth2Client: oauth },
  });

  // (c) Реальное приложение в cloud mode (store/render/service — фейки).
  const ranJobs = [];
  const built = await createApp({
    config,
    store: { kind: 'firestore' }, // проходит assertStoreForMode, не используется
    verifier: fakeVerifier(),
    gemini: fakeGemini(),
    media: fakeMedia(),
    render: { signer: {}, jobs: {} },
    service: {
      setHandler() {},
      async runJob(jobId, payload) {
        ranJobs.push({ jobId, payload });
        return { ok: true };
      },
    },
    oidcVerifier,
    taskQueue: { setHandler() {}, enqueue: async () => ({ scheduled: true }) },
  });

  const server = http.createServer(built.app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}${taskUrl.pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer minted-oidc-token' },
      body: JSON.stringify({ jobId: 'job-10', uid: 'u1' }),
    });

    // Endpoint дошёл до задачи только потому, что audience совпал сквозь всю
    // проводку: payload Cloud Tasks → internalGuard → verifyIdToken.
    assert.equal(res.status, 200);
    assert.equal(oauth.calls.length, 1, 'реальный OAuth2Client был вызван');
    assert.equal(oauth.calls[0].audience, taskAudience, 'audience guard == audience payload');
    assert.equal(taskAudience, STABLE_ORIGIN);
    assert.ok(!taskAudience.includes('/internal'), 'канонический audience без пути');
    assert.equal(taskUrl.pathname, INTERNAL_TASK_PATH);
    assert.equal(ranJobs.length, 1, 'задача действительно исполнена');
    assert.equal(ranJobs[0].jobId, 'job-10');
  } finally {
    server.close();
    await once(server, 'close');
  }
});
