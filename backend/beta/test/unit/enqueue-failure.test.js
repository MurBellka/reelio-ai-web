// Обработка сорвавшегося enqueue (§4A.6/§4A.7).
//
// Дефект, найденный вживую: транзакция коммитила job как `queued` ДО enqueue,
// а enqueue падал (INVALID_ARGUMENT из-за точки в ID) → HTTP 500 и задача
// навсегда в `queued`, занимая active slot. Теперь при сбое enqueue задача
// переводится в терминальное `failed`, слот освобождается, квота возвращается
// ровно один раз, повтор идемпотентен, а явный retry создаёт рабочую попытку.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AnalysisService } from '../../src/analysis-service.js';
import { MemoryStore, buildQuotaOps } from '../../src/store.js';
import { assetsFor, fakeMedia, fakeGemini, startServer, waitForTerminal } from '../helpers/harness.js';

/** Ошибка вида Cloud Tasks INVALID_ARGUMENT (gRPC-код 3). */
function invalidArgument() {
  return Object.assign(new Error('INVALID_ARGUMENT: task id contains a dot'), { code: 3 });
}

/**
 * Управляемая очередь: `failWith` заставляет enqueue бросить; иначе она ведёт
 * себя как InlineTaskQueue — запускает обработчик асинхронно, чтобы задача
 * реально завершилась (для проверки рабочего retry).
 */
function controllableQueue() {
  let handler = null;
  const q = {
    failWith: null,
    calls: [],
    setHandler(h) {
      handler = h;
    },
    async enqueue(payload) {
      q.calls.push(payload);
      if (q.failWith) throw q.failWith;
      Promise.resolve()
        .then(() => handler?.(payload))
        .catch(() => {});
      return { scheduled: true };
    },
  };
  return q;
}

// ── 8: INVALID_ARGUMENT переводит job из queued в failed ─────────────────────

test('8. сбой enqueue переводит job из queued в failed с безопасным retryable-кодом', async () => {
  const taskQueue = controllableQueue();
  taskQueue.failWith = invalidArgument();
  const harness = await startServer({ taskQueue, gemini: fakeGemini(), media: fakeMedia() });
  try {
    const res = await harness.request('POST', '/analysis', {
      body: { projectId: 'proj_8', assets: assetsFor('user_1', 'proj_8', 1) },
    });

    // Ответ — 200 (терминальное состояние), а не 202 и не 500.
    assert.equal(res.status, 200);
    assert.equal(res.body.analysis.status, 'failed');
    assert.equal(res.body.analysis.error.code, 'ANALYSIS_ENQUEUE_FAILED');
    assert.equal(res.body.analysis.error.retryable, true);

    // И в хранилище задача действительно failed, а не застряла в queued.
    const got = await harness.request('GET', `/analysis/${res.body.analysis.analysisId}`);
    assert.equal(got.body.analysis.status, 'failed');
  } finally {
    await harness.close();
  }
});

// ── 9: после сбоя enqueue нет активной задачи, квота возвращена (create-путь) ─

test('9. после сбоя enqueue active slot освобождён и квота не потрачена', async () => {
  const taskQueue = controllableQueue();
  taskQueue.failWith = invalidArgument();
  const harness = await startServer({ taskQueue, gemini: fakeGemini(), media: fakeMedia() });
  try {
    await harness.request('POST', '/analysis', {
      body: { projectId: 'proj_9', assets: assetsFor('user_1', 'proj_9', 1) },
    });

    assert.equal(harness.store.countActiveJobs('user_1'), 0, 'терминальный job не занимает слот');
    const usage = await harness.quota.usage('user_1', 'proj_9');
    assert.equal(usage.user, 0, 'квота при создании не списывалась');
    assert.equal(usage.project, 0);
  } finally {
    await harness.close();
  }
});

// ── 9b: возврат квоты РОВНО ОДИН РАЗ, когда кредиты уже были списаны ──────────

test('9b. re-enqueue failure возвращает списанные кредиты ровно один раз', async () => {
  const store = new MemoryStore();
  const quota = buildQuotaOps({ limits: { perUserPerDay: 20, perProjectPerDay: 8 }, store });
  const now = () => new Date('2026-07-29T10:00:00Z');
  const taskQueue = { enqueue: async () => { throw invalidArgument(); }, setHandler() {} };
  const service = new AnalysisService({
    store,
    quota,
    limits: { maxActiveAnalyses: 2 },
    gemini: null,
    media: fakeMedia(),
    now,
    taskQueue,
  });

  const uid = 'user_1';
  const projectId = 'proj_9b';

  // Имитируем прошлый частичный прогон: 2 списанных кредита и failed-задача.
  await store.runTransaction((tx) => quota.charge(tx, { uid, projectId, now: now() }));
  await store.runTransaction((tx) => quota.charge(tx, { uid, projectId, now: now() }));
  assert.equal((await quota.usage(uid, projectId, now())).user, 2);

  await store.runTransaction((tx) =>
    tx.putJob({
      id: 'an_credit',
      uid,
      projectId,
      fingerprint: 'fp_credit',
      status: 'failed',
      phase: 'failed',
      progress: 1,
      creditsSpent: 2,
      assetsTotal: 1,
      analyses: [],
      warnings: [],
      error: { code: 'ANALYSIS_FAILED', message: 'x', retryable: true },
      createdAt: now().toISOString(),
      updatedAt: now().toISOString(),
      finishedAt: now().toISOString(),
    }),
  );

  // retry → revive(queued, кредиты сохранены) → enqueue падает → failed + refund.
  const first = await service.retryAnalysis(uid, 'an_credit', assetsFor(uid, projectId, 1));
  assert.equal(first.job.status, 'failed');
  assert.equal(first.job.creditsSpent, 0);
  assert.equal(first.job.error.code, 'ANALYSIS_ENQUEUE_FAILED');
  assert.equal((await quota.usage(uid, projectId, now())).user, 0, 'кредиты возвращены');
  assert.equal(store.countActiveJobs(uid), 0);

  // Ещё один retry (кредитов уже 0) не уводит квоту в минус — возврат идемпотентен.
  const second = await service.retryAnalysis(uid, 'an_credit', assetsFor(uid, projectId, 1));
  assert.equal(second.job.status, 'failed');
  assert.equal((await quota.usage(uid, projectId, now())).user, 0, 'без повторного возврата');
});

// ── 10: повтор Idempotency-Key не списывает и не создаёт вторую задачу ────────

test('10. повтор с тем же Idempotency-Key возвращает ту же failed-задачу без списания', async () => {
  const taskQueue = controllableQueue();
  taskQueue.failWith = invalidArgument();
  const harness = await startServer({ taskQueue, gemini: fakeGemini(), media: fakeMedia() });
  try {
    const body = { projectId: 'proj_10', assets: assetsFor('user_1', 'proj_10', 1) };
    const headers = { 'Idempotency-Key': 'key-abc' };

    const first = await harness.request('POST', '/analysis', { body, headers });
    const second = await harness.request('POST', '/analysis', { body, headers });

    assert.equal(second.status, 200);
    assert.equal(second.body.analysis.analysisId, first.body.analysis.analysisId, 'та же задача');
    assert.equal(taskQueue.calls.length, 1, 'второй раз enqueue не вызывается');
    assert.equal(harness.store.jobs.size, 1, 'вторая задача не создаётся');
    const usage = await harness.quota.usage('user_1', 'proj_10');
    assert.equal(usage.user, 0, 'повторного списания нет');
  } finally {
    await harness.close();
  }
});

// ── 12: retry после failed создаёт рабочую попытку ───────────────────────────

test('12. retry после сорвавшегося enqueue создаёт работающую попытку', async () => {
  const taskQueue = controllableQueue();
  taskQueue.failWith = invalidArgument();
  const harness = await startServer({ taskQueue, gemini: fakeGemini(), media: fakeMedia() });
  try {
    const assets = assetsFor('user_1', 'proj_12', 1);
    const created = await harness.request('POST', '/analysis', {
      body: { projectId: 'proj_12', assets },
    });
    assert.equal(created.body.analysis.status, 'failed');
    const id = created.body.analysis.analysisId;

    // Очередь «починилась» — retry ставит задачу и она доходит до succeeded.
    taskQueue.failWith = null;
    const retried = await harness.request('POST', `/analysis/${id}/retry`, { body: { assets } });
    assert.equal(retried.status, 202, 'принят новый прогон');

    const terminal = await waitForTerminal(harness, id);
    assert.equal(terminal.status, 'succeeded');
  } finally {
    await harness.close();
  }
});

// ── happy-path: успешный enqueue оставляет задачу queued (не трогаем поведение) ─

test('успешный enqueue не переводит задачу в failed', async () => {
  const taskQueue = controllableQueue(); // failWith = null
  const harness = await startServer({ taskQueue, gemini: fakeGemini(), media: fakeMedia() });
  try {
    const res = await harness.request('POST', '/analysis', {
      body: { projectId: 'proj_ok', assets: assetsFor('user_1', 'proj_ok', 1) },
    });
    // 202 — принято в очередь; статус — не failed.
    assert.equal(res.status, 202);
    assert.notEqual(res.body.analysis.status, 'failed');
    await waitForTerminal(harness, res.body.analysis.analysisId);
  } finally {
    await harness.close();
  }
});
