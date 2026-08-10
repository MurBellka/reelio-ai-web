// Повторные попытки Cloud Tasks и watchdog зависших `queued` (§4A.9).
//
// Дефект (найден независимым ревью): retryAnalysis переиспользовал тот же jobId,
// значит формировал ТО ЖЕ имя Cloud Task. Cloud Tasks держит имя завершённой
// задачи в дедуп-окне ~1 час → createTask отвечает ALREADY_EXISTS, код считал
// это успехом, но новая задача не запускалась → анализ навсегда в `queued`.
//
// Фикс: номер попытки enqueueSeq входит в имя (`…-a<seq>`); retry атомарно
// увеличивает его → новое имя → задача реально ставится. Плюс durable-watchdog
// (отложенная reap-задача + защитная проверка просроченных queued).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AnalysisService } from '../../src/analysis-service.js';
import { MemoryStore, buildQuotaOps } from '../../src/store.js';
import { buildTaskId } from '../../src/tasks.js';
import { assetsFor, fakeGemini, fakeMedia, startServer, waitForTerminal } from '../helpers/harness.js';

/** Управляемые часы: now() как функция + advance(ms). */
function clock(startMs = 1_000_000) {
  let t = startMs;
  const now = () => new Date(t);
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

function makeQuota(store) {
  return buildQuotaOps({ limits: { perUserPerDay: 20, perProjectPerDay: 8 }, store });
}

function invalidArgument() {
  return Object.assign(new Error('INVALID_ARGUMENT: task id'), { code: 3 });
}

// ── req 5.7: просроченная queued → failed, слот освобождён, кредит возвращён раз ─

test('§4A.9: просроченная queued → failed (QUEUE_TIMEOUT), слот свободен, возврат кредита один раз', async () => {
  const now = clock();
  const store = new MemoryStore();
  const quota = makeQuota(store);
  const service = new AnalysisService({
    store,
    quota,
    limits: { maxActiveAnalyses: 2 },
    gemini: null,
    media: fakeMedia(),
    now,
    queueTimeoutMs: 1000,
  });
  const uid = 'u';
  const projectId = 'p';

  // Задача, застрявшая в queued с одним списанным кредитом.
  await store.runTransaction((t) => quota.charge(t, { uid, projectId, now: now() }));
  await store.runTransaction((t) =>
    t.putJob({
      id: 'an_stale',
      uid,
      projectId,
      status: 'queued',
      phase: 'queued',
      enqueueSeq: 1,
      queuedAt: now().toISOString(),
      createdAt: now().toISOString(),
      creditsSpent: 1,
    }),
  );

  // До таймаута watchdog не трогает задачу (защита от раннего срабатывания).
  const early = await service.reapQueued('an_stale', 1);
  assert.equal(early.status, 'queued');

  now.advance(1500); // время ожидания вышло

  const reaped = await service.reapQueued('an_stale', 1);
  assert.equal(reaped.status, 'failed');
  assert.equal(reaped.error.code, 'ANALYSIS_QUEUE_TIMEOUT');
  assert.equal(reaped.error.retryable, true);
  assert.equal(store.countActiveJobs(uid), 0, 'active slot освобождён');
  assert.equal((await quota.usage(uid, projectId, now())).user, 0, 'кредит возвращён');

  // Повторный reap — no-op, без второго возврата (кредит не уходит в минус).
  const again = await service.reapQueued('an_stale', 1);
  assert.equal(again.status, 'failed');
  assert.equal((await quota.usage(uid, projectId, now())).user, 0, 'без повторного возврата');
});

// ── req 5.8: watchdog старой попытки — no-op ─────────────────────────────────

test('§4A.9: watchdog старой попытки — no-op после retry и после завершения', async () => {
  const now = clock();
  const store = new MemoryStore();
  const service = new AnalysisService({
    store,
    quota: makeQuota(store),
    limits: { maxActiveAnalyses: 2 },
    gemini: null,
    media: fakeMedia(),
    now,
    queueTimeoutMs: 1000,
  });

  // Задача уже на попытке 2 (как после retry), снова queued.
  await store.runTransaction((t) =>
    t.putJob({
      id: 'an_b',
      uid: 'u',
      projectId: 'p',
      status: 'queued',
      phase: 'queued',
      enqueueSeq: 2,
      queuedAt: now().toISOString(),
      createdAt: now().toISOString(),
      creditsSpent: 0,
    }),
  );
  now.advance(5000); // даже с запасом по времени

  // Watchdog старой попытки (seq=1) не трогает актуальную попытку 2.
  const r1 = await service.reapQueued('an_b', 1);
  assert.equal(r1.status, 'queued', 'чужой enqueueSeq — no-op');
  assert.equal(r1.enqueueSeq, 2);

  // Задача завершилась — watchdog её попытки тоже no-op (не «возрождает» терминал).
  await store.runTransaction(async (t) => t.putJob({ ...(await t.getJob('an_b')), status: 'succeeded' }));
  const r2 = await service.reapQueued('an_b', 2);
  assert.equal(r2.status, 'succeeded');
});

// ── req 5.5: два конкурентных retry не создают две оплаченные попытки ─────────

test('§4A.9: два конкурентных retry не создают две попытки', async () => {
  const now = clock();
  const store = new MemoryStore();
  const quota = makeQuota(store);
  const enqueued = [];
  const queue = {
    setHandler() {},
    async enqueue(p) {
      enqueued.push(p);
      // handler не запускаем: важен только факт постановки.
      return { scheduled: true };
    },
  };
  const service = new AnalysisService({
    store,
    quota,
    limits: { maxActiveAnalyses: 2 },
    gemini: fakeGemini(),
    media: fakeMedia(),
    now,
    taskQueue: queue,
    queueTimeoutMs: 600_000,
  });
  const uid = 'u';
  const projectId = 'p';

  // Терминальная failed-задача, попытка 1.
  await store.runTransaction((t) =>
    t.putJob({
      id: 'an_c',
      uid,
      projectId,
      fingerprint: 'fpc',
      status: 'failed',
      phase: 'failed',
      enqueueSeq: 1,
      creditsSpent: 0,
      createdAt: now().toISOString(),
      updatedAt: now().toISOString(),
      finishedAt: now().toISOString(),
      error: { code: 'UPSTREAM_FAILED' },
    }),
  );

  const assets = assetsFor(uid, projectId, 1);
  const results = await Promise.allSettled([
    service.retryAnalysis(uid, 'an_c', assets),
    service.retryAnalysis(uid, 'an_c', assets),
  ]);

  const ok = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1, 'ровно один retry возродил задачу');
  assert.equal(rejected.length, 1, 'второй отклонён');
  assert.equal(rejected[0].reason.code, 'ANALYSIS_ALREADY_TERMINAL');

  const runEnqueues = enqueued.filter((p) => p.kind === 'analysis.run');
  assert.equal(runEnqueues.length, 1, 'ровно один enqueue новой попытки');
  assert.equal(runEnqueues[0].enqueueSeq, 2);
  assert.equal((await store.getJob('an_c')).enqueueSeq, 2, 'ровно один инкремент попытки');
});

// ── req 5.6: сорвавшийся enqueue старой попытки не рушит новую ────────────────

test('§4A.9: enqueue-сбой старой попытки не переводит новую попытку в failed', async () => {
  const now = clock();
  const store = new MemoryStore();
  const quota = makeQuota(store);

  // Очередь симулирует гонку: пока enqueue попытки 1 «падал», конкурентный retry
  // уже поднял попытку 2 (инкремент enqueueSeq в хранилище). Затем enqueue бросает.
  const queue = {
    setHandler() {},
    async enqueue(p) {
      await store.runTransaction(async (tx) => {
        const j = await tx.getJob(p.jobId);
        await tx.putJob({
          ...j,
          enqueueSeq: (j.enqueueSeq ?? 1) + 1,
          status: 'queued',
          queuedAt: now().toISOString(),
        });
      });
      throw invalidArgument();
    },
  };
  const service = new AnalysisService({
    store,
    quota,
    limits: { maxActiveAnalyses: 2 },
    gemini: fakeGemini(),
    media: fakeMedia(),
    now,
    taskQueue: queue,
    queueTimeoutMs: 600_000,
  });

  const { job } = await service.createAnalysis({
    uid: 'u',
    projectId: 'p',
    assets: assetsFor('u', 'p', 1),
  });

  // #failEnqueue(seq=1) видит уже seq=2 → guard по enqueueSeq → no-op.
  assert.equal(job.status, 'queued', 'новая попытка осталась queued');
  assert.equal(job.enqueueSeq, 2);
  const stored = await store.getJob(job.id);
  assert.equal(stored.status, 'queued');
  assert.equal(stored.enqueueSeq, 2);
});

// ── req 5.1–5.4: tombstone Cloud Tasks — retry обходит его и реально запускается ─

/**
 * Фейковая очередь как Cloud Tasks: имя детерминировано из (kind, jobId, seq);
 * по завершении задачи имя остаётся tombstone'ом → повтор ТОГО ЖЕ имени =
 * ALREADY_EXISTS (обработчик НЕ запускается). Новая попытка = новое имя.
 */
function tombstoneQueue() {
  const live = new Set();
  const tombstones = new Set();
  const created = [];
  let handler = null;
  return {
    created,
    tombstones,
    setHandler(h) {
      handler = h;
    },
    async enqueue(p) {
      const name = buildTaskId(p.kind, p.jobId, p.enqueueSeq);
      if (live.has(name) || tombstones.has(name)) {
        return { scheduled: true, alreadyExists: true, name };
      }
      live.add(name);
      created.push(name);
      Promise.resolve()
        .then(() => handler?.(p))
        .catch(() => {})
        .finally(() => {
          live.delete(name);
          tombstones.add(name); // как дедуп-окно Cloud Tasks
        });
      return { scheduled: true, name };
    },
  };
}

/** Gemini с переключаемым сбоем: attempt 1 падает, retry — успех. */
function togglingGemini() {
  const g = {
    model: 'fake',
    calls: [],
    fail: Object.assign(new Error('boom'), { code: 'UPSTREAM_FAILED' }),
    async generateJson(a) {
      g.calls.push(a);
      if (g.fail) throw g.fail;
      return {
        json: {
          summary: 'ok',
          quality: { overall: 0.8, sharpness: 0.7, exposure: 0.6, stability: 0.9 },
          scenes: [{ start: 0, end: 5, shotType: 'wide', motion: 'slow', quality: 0.8 }],
          subjects: [{ kind: 'person', box: { x: 0.3, y: 0.2, width: 0.4, height: 0.5 }, isPrimary: true }],
          moments: [{ start: 1, end: 4, kind: 'highlight', score: 0.9 }],
          issues: [],
        },
        usage: { promptTokens: 10, outputTokens: 5 },
      };
    },
  };
  return g;
}

test('§4A.9: retry с новым enqueueSeq обходит tombstone и реально запускается', async () => {
  const queue = tombstoneQueue();
  const gemini = togglingGemini();
  const harness = await startServer({ taskQueue: queue, gemini, media: fakeMedia() });
  try {
    const assets = assetsFor('user_1', 'pt', 1);

    // Попытка 1 запускается и падает; её имя (…-a1) остаётся tombstone'ом.
    const created1 = await harness.request('POST', '/analysis', { body: { projectId: 'pt', assets } });
    const id = created1.body.analysis.analysisId;
    const failed = await waitForTerminal(harness, id);
    assert.equal(failed.status, 'failed');
    assert.equal(queue.created.length, 1);
    assert.match(queue.created[0], /-a1$/);
    assert.ok(queue.tombstones.size === 1, 'имя попытки 1 в дедуп-окне');

    // Очередь/модель «починились». Retry берёт НОВОЕ имя (…-a2), не сталкиваясь
    // с tombstone'ом, и задача реально доходит до succeeded (не зависает queued).
    gemini.fail = null;
    const retried = await harness.request('POST', `/analysis/${id}/retry`, { body: { assets } });
    assert.equal(retried.status, 202);
    assert.equal(retried.body.analysis.status, 'queued');

    const done = await waitForTerminal(harness, id);
    assert.equal(done.status, 'succeeded', 'retry запустился, а не остался queued');
    assert.equal(queue.created.length, 2, 'создано новое имя задачи');
    assert.match(queue.created[1], /-a2$/);
  } finally {
    await harness.close();
  }
});

test('§4A.9: повтор create той же попытки идемпотентен (без второй задачи/enqueue)', async () => {
  const queue = tombstoneQueue();
  const gemini = fakeGemini();
  const harness = await startServer({ taskQueue: queue, gemini, media: fakeMedia() });
  try {
    const body = { projectId: 'pi', assets: assetsFor('user_1', 'pi', 1) };
    const headers = { 'Idempotency-Key': 'same-key' };

    const first = await harness.request('POST', '/analysis', { body, headers });
    const second = await harness.request('POST', '/analysis', { body, headers });

    assert.equal(second.body.analysis.analysisId, first.body.analysis.analysisId, 'та же задача');
    assert.equal(queue.created.length, 1, 'вторая задача не ставится');
  } finally {
    await harness.close();
  }
});

// ── req 6: reap-endpoint закрыт тем же OIDC (audience/email не ослаблены) ─────

test('§4A.9: reap-endpoint закрыт без валидного OIDC, с валидным — reap выполняется', async () => {
  const oidcVerifier = {
    async verify(token) {
      if (token !== 'good-oidc') throw new Error('bad oidc');
      return { email: 'tasks@example.com' };
    },
  };
  // Очередь-заглушка: НЕ запускает обработчик, чтобы задача осталась queued.
  const taskQueue = { setHandler() {}, enqueue: async () => ({ scheduled: true }) };
  const harness = await startServer({ oidcVerifier, taskQueue, gemini: fakeGemini(), media: fakeMedia() });
  try {
    // Без токена — 401, неверный — 403.
    const noToken = await harness.request('POST', '/internal/analysis/reap', {
      uid: null,
      appCheck: null,
      body: { jobId: 'an_x', enqueueSeq: 1 },
    });
    assert.equal(noToken.status, 401);

    const badToken = await harness.request('POST', '/internal/analysis/reap', {
      uid: null,
      appCheck: null,
      headers: { Authorization: 'Bearer nope' },
      body: { jobId: 'an_x', enqueueSeq: 1 },
    });
    assert.equal(badToken.status, 403);

    // Валидный OIDC — endpoint отрабатывает (несуществующая задача → no-op ok).
    const ok = await harness.request('POST', '/internal/analysis/reap', {
      uid: null,
      appCheck: null,
      headers: { Authorization: 'Bearer good-oidc' },
      body: { jobId: 'an_x', enqueueSeq: 1 },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
  } finally {
    await harness.close();
  }
});
