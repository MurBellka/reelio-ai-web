// Integration Iteration 4A: deployable beta backend.
//
// Проверяется без облака и без эмулятора:
//   • cloud mode отвергает MemoryStore;
//   • FirestoreStore реализует тот же интерфейс (на фейковом db);
//   • долговечное выполнение вместо fire-and-forget: повтор идемпотентен,
//     отмена останавливает Gemini, исчерпание повторов даёт терминал;
//   • внутренний endpoint закрыт без валидного OIDC.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertStoreForMode, createStore, MemoryStore } from '../../src/store.js';
import { FirestoreStore } from '../../src/store-firestore.js';
import { startServer, fakeGemini, fakeMedia, assetsFor, waitForTerminal } from '../helpers/harness.js';

// ── 4A.5: облачный guard ────────────────────────────────────────────────────

test('cloud mode отвергает MemoryStore, local — допускает', () => {
  assert.throws(() => assertStoreForMode({ mode: 'cloud' }, new MemoryStore()), /Firestore/);
  assert.doesNotThrow(() => assertStoreForMode({ mode: 'local' }, new MemoryStore()));
});

test('createStore локально возвращает MemoryStore', async () => {
  const store = await createStore({ storeKind: 'memory', mode: 'local' });
  assert.equal(store.kind, 'memory');
});

// ── 4A.4: FirestoreStore на фейковом Firestore ──────────────────────────────

/** Минимальный фейк Firestore: транзакции, документы, простые where-запросы. */
function fakeFirestore() {
  const data = new Map(); // `${col}/${id}` → object
  const key = (col, id) => `${col}/${id}`;

  const docRef = (col, id) => ({
    col,
    id,
    async get() {
      const v = data.get(key(col, id));
      return { exists: v !== undefined, data: () => v };
    },
    async set(value) {
      data.set(key(col, id), value);
    },
  });

  const query = (col, filters = []) => ({
    col,
    filters,
    where(field, _op, value) {
      return query(col, [...filters, { field, value }]);
    },
    _match() {
      const rows = [];
      for (const [k, v] of data.entries()) {
        if (!k.startsWith(`${col}/`)) continue;
        if (filters.every((f) => v[f.field] === f.value)) rows.push(v);
      }
      return rows;
    },
  });

  const collection = (col) => ({
    doc: (id) => docRef(col, id),
    where: (field, op, value) => query(col).where(field, op, value),
  });

  const tx = {
    async get(refOrQuery) {
      if (typeof refOrQuery.get === 'function' && refOrQuery.id) return refOrQuery.get();
      const rows = refOrQuery._match();
      return { size: rows.length };
    },
    set(ref, value) {
      data.set(key(ref.col, ref.id), value);
    },
  };

  return {
    collection,
    async runTransaction(fn) {
      return fn(tx);
    },
    _data: data,
  };
}

test('FirestoreStore: транзакции, счётчики и активные задачи', async () => {
  const store = new FirestoreStore(fakeFirestore());

  await store.runTransaction(async (t) => {
    await t.putJob({ id: 'an_1', uid: 'u1', status: 'queued', fingerprint: 'fp1' });
    await t.putJob({ id: 'an_2', uid: 'u1', status: 'running' });
    await t.putJob({ id: 'an_3', uid: 'u1', status: 'succeeded' });
    await t.writeCounter('u_u1_2026-01-01', 3);
  });

  await store.runTransaction(async (t) => {
    assert.equal((await t.getJob('an_1')).status, 'queued');
    assert.equal((await t.findJobByFingerprint('fp1')).id, 'an_1');
    // Два незавершённых (queued, running), один терминальный (succeeded).
    assert.equal(await t.countActiveJobs('u1'), 2);
    assert.equal(await t.readCounter('u_u1_2026-01-01'), 3);
  });

  await store.putAnalysis('fp-content', { summary: 'ok' });
  assert.equal((await store.getAnalysis('fp-content')).summary, 'ok');
});

// ── 4A.7: долговечное выполнение ────────────────────────────────────────────

test('повтор задачи не вызывает Gemini заново (идемпотентность)', async () => {
  const gemini = fakeGemini();
  const harness = await startServer({ gemini, media: fakeMedia() });
  try {
    const assets = assetsFor('user_1', 'proj_i', 1);
    const res = await harness.request('POST', '/analysis', {
      body: { projectId: 'proj_i', assets },
      headers: { 'Idempotency-Key': 'k-idem' },
    });
    const id = res.body.analysis.analysisId;
    await waitForTerminal(harness, id);
    const callsAfterFirst = gemini.calls.length;
    assert.ok(callsAfterFirst > 0, 'Gemini должен быть вызван хотя бы раз');

    // Прямой повторный запуск той же (уже завершённой) задачи — no-op.
    await harness.service.runJob(id, { uid: 'user_1', projectId: 'proj_i', assets });
    assert.equal(gemini.calls.length, callsAfterFirst, 'повтор не должен звать Gemini');
  } finally {
    await harness.close();
  }
});

test('исчерпание повторов даёт терминальный failed', async () => {
  const err = Object.assign(new Error('upstream down'), { code: 'UPSTREAM_FAILED' });
  const gemini = fakeGemini({ fail: err });
  const harness = await startServer({ gemini, media: fakeMedia() });
  try {
    const res = await harness.request('POST', '/analysis', {
      body: { projectId: 'proj_f', assets: assetsFor('user_1', 'proj_f', 1) },
    });
    const terminal = await waitForTerminal(harness, res.body.analysis.analysisId);
    assert.equal(terminal.status, 'failed');
    assert.equal(terminal.error?.retryable, true);
    // Повторялось несколько раз (maxAttempts=3), но не бесконечно.
    assert.ok(gemini.calls.length >= 2 && gemini.calls.length <= 3, `вызовов: ${gemini.calls.length}`);
  } finally {
    await harness.close();
  }
});

test('отмена останавливает дальнейший расход Gemini', async () => {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const calls = [];
  const gemini = {
    model: 'fake',
    calls,
    async generateJson({ signal, schema }) {
      calls.push(schema?.properties?.segments ? 'speech' : 'vision');
      await gate; // держим первый вызов, пока тест не отменит задачу
      if (signal?.aborted) {
        throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
      }
      return { json: { summary: 'x', quality: {}, scenes: [], subjects: [], moments: [], issues: [] }, usage: { promptTokens: 1, outputTokens: 1 } };
    },
  };
  const harness = await startServer({ gemini, media: fakeMedia() });
  try {
    const res = await harness.request('POST', '/analysis', {
      body: { projectId: 'proj_c', assets: assetsFor('user_1', 'proj_c', 2) },
    });
    const id = res.body.analysis.analysisId;

    // Ждём, пока первый вызов Gemini окажется в полёте.
    for (let i = 0; i < 100 && calls.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(calls.length, 1, 'первый материал уже в анализе');

    await harness.request('POST', `/analysis/${id}/cancel`);
    release();

    const terminal = await waitForTerminal(harness, id);
    assert.equal(terminal.status, 'cancelled');
    // Второй материал в Gemini уже не пошёл.
    assert.equal(calls.length, 1, 'после отмены новых вызовов Gemini нет');
  } finally {
    release?.();
    await harness.close();
  }
});

// ── 4A.7: внутренний endpoint защищён OIDC ──────────────────────────────────

test('внутренний endpoint закрыт без валидного OIDC и запускает задачу с ним', async () => {
  const oidcVerifier = {
    async verify(token) {
      if (token !== 'good-oidc') throw new Error('bad oidc');
      return { email: 'tasks@example.com' };
    },
  };
  // Очередь-заглушка: НЕ запускает обработчик, чтобы задачу запустил именно
  // внутренний endpoint.
  const taskQueue = { setHandler() {}, enqueue: async () => ({ scheduled: true }) };
  const harness = await startServer({ oidcVerifier, taskQueue, gemini: fakeGemini(), media: fakeMedia() });
  try {
    const assets = assetsFor('user_1', 'proj_o', 1);
    const created = await harness.request('POST', '/analysis', {
      body: { projectId: 'proj_o', assets },
    });
    const id = created.body.analysis.analysisId;
    assert.equal(created.body.analysis.status, 'queued');

    // Без токена — 401.
    const noToken = await harness.request('POST', '/internal/analysis/run', {
      uid: null,
      appCheck: null,
      body: { jobId: id },
    });
    assert.equal(noToken.status, 401);

    // Неверный OIDC — 403.
    const badToken = await harness.request('POST', '/internal/analysis/run', {
      uid: null,
      appCheck: null,
      headers: { Authorization: 'Bearer nope' },
      body: { jobId: id },
    });
    assert.equal(badToken.status, 403);

    // Валидный OIDC — задача выполняется.
    const ok = await harness.request('POST', '/internal/analysis/run', {
      uid: null,
      appCheck: null,
      headers: { Authorization: 'Bearer good-oidc' },
      body: { jobId: id, uid: 'user_1', projectId: 'proj_o', assets },
    });
    assert.equal(ok.status, 200);

    const terminal = await waitForTerminal(harness, id);
    assert.equal(terminal.status, 'succeeded');
  } finally {
    await harness.close();
  }
});
