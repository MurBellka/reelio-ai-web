// FirestoreStore на Firestore emulator (§4D). Реальный SDK против эмулятора —
// без облака и без реальных ресурсов.
//
// В CI эмулятор ОБЯЗАН быть поднят: v2-verify.yml запускает его и выставляет
// REELIO_REQUIRE_EMULATOR=1. Тогда пропуск теста считается ошибкой. Локально,
// без FIRESTORE_EMULATOR_HOST, тест пропускается, чтобы не мешать обычному
// прогону:
//
//   firebase emulators:exec --only firestore --project demo-reelio \
//     'REELIO_REQUIRE_EMULATOR=1 node --test test/e2e/firestore-store.test.js'

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildQuotaOps } from '../../src/store.js';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
const REQUIRE = process.env.REELIO_REQUIRE_EMULATOR === '1';

const config = { firebase: { projectId: process.env.GOOGLE_CLOUD_PROJECT || 'demo-reelio' } };

// skip только когда эмулятора нет И его не требуют. В CI REQUIRE=1 → тест
// выполняется; если при этом HOST не задан — падаем (пропуск = ошибка).
test('FirestoreStore: durability, идемпотентность, квоты, отмена', { skip: !HOST && !REQUIRE }, async () => {
  if (REQUIRE && !HOST) {
    throw new Error('Firestore emulator обязателен в CI, но FIRESTORE_EMULATOR_HOST не задан.');
  }
  const { FirestoreStore } = await import('../../src/store-firestore.js');

  // ── 1. Данные переживают ПЕРЕСОЗДАНИЕ инстанса (не в памяти процесса) ──────
  const store = await FirestoreStore.create(config);
  await store.runTransaction(async (t) => {
    await t.putJob({ id: 'an_e1', uid: 'ue', status: 'queued', fingerprint: 'fpe1', projectId: 'pe' });
    await t.putJob({ id: 'an_e2', uid: 'ue', status: 'succeeded', projectId: 'pe' });
  });

  const store2 = await FirestoreStore.create(config);
  await store2.runTransaction(async (t) => {
    assert.equal((await t.getJob('an_e1')).status, 'queued');
    // Активна только незавершённая задача.
    assert.equal(await t.countActiveJobs('ue'), 1);
  });

  // ── 1b. listActiveJobs (§4A.9): нетранзакционный список незавершённых ──────
  // На нём держится защитная проверка просроченных queued перед резервированием
  // слота — гоняем против реального эмулятора (fake-Firestore юнит-тест не умеет
  // .get() по составному where-запросу).
  const active = await store2.listActiveJobs('ue');
  assert.equal(active.length, 1, 'только незавершённая задача активна');
  assert.equal(active[0].id, 'an_e1');
  assert.equal(active[0].enqueueSeq ?? 1, 1);

  // ── 2. Транзакционная идемпотентность по отпечатку запроса ────────────────
  await store2.runTransaction(async (t) => {
    assert.equal((await t.findJobByFingerprint('fpe1')).id, 'an_e1');
  });
  // Повторное «создание» с тем же отпечатком видит уже существующую задачу.
  const dup = await store2.runTransaction(async (t) => t.findJobByFingerprint('fpe1'));
  assert.equal(dup.id, 'an_e1');

  // ── 3. Квоты: списание и возврат в транзакции ─────────────────────────────
  const quota = buildQuotaOps({ limits: { perUserPerDay: 5, perProjectPerDay: 5 }, store: store2 });
  const now = new Date('2026-05-01T00:00:00Z');
  await store2.runTransaction((t) => quota.charge(t, { uid: 'uq', projectId: 'pq', now }));
  await store2.runTransaction((t) => quota.charge(t, { uid: 'uq', projectId: 'pq', now }));
  let usage = await quota.usage('uq', 'pq', now);
  assert.equal(usage.user, 2);
  assert.equal(usage.project, 2);
  await store2.runTransaction((t) => quota.refund(t, { uid: 'uq', projectId: 'pq', now }));
  usage = await quota.usage('uq', 'pq', now);
  assert.equal(usage.user, 1, 'возврат квоты за отменённую работу');

  // ── 4. Отмена: перевод в терминал сохраняется durable ─────────────────────
  await store2.runTransaction(async (t) => {
    const job = await t.getJob('an_e1');
    await t.putJob({ ...job, status: 'cancelled' });
  });
  const store3 = await FirestoreStore.create(config);
  await store3.runTransaction(async (t) => {
    assert.equal((await t.getJob('an_e1')).status, 'cancelled');
    // После отмены активных задач у пользователя не осталось.
    assert.equal(await t.countActiveJobs('ue'), 0);
  });

  // ── 5. Render job — тот же интерфейс, тоже durable ────────────────────────
  await store3.runTransaction(async (t) => {
    await t.putRenderJob({ id: 'job_e1', uid: 'ue', status: 'running', projectId: 'pe', fingerprint: 'rfp1' });
  });
  const store4 = await FirestoreStore.create(config);
  assert.equal((await store4.getRenderJob('job_e1')).status, 'running');
  await store4.runTransaction(async (t) => {
    assert.equal((await t.findRenderJobByFingerprint('rfp1')).id, 'job_e1');
    assert.equal(await t.countActiveRenderJobs('ue'), 1);
  });
});
