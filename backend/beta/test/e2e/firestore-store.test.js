// FirestoreStore на Firestore emulator (§4D). Реальный SDK против эмулятора —
// без облака и без реальных ресурсов.
//
// Тест ПРОПУСКАЕТСЯ, если не поднят эмулятор (FIRESTORE_EMULATOR_HOST) или в
// окружении нет @google-cloud/firestore. Так он не мешает обычному прогону, но
// доступен там, где эмулятор запущен:
//
//   gcloud emulators firestore start --host-port=127.0.0.1:8085
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 GOOGLE_CLOUD_PROJECT=demo-reelio \
//     node --test test/e2e/firestore-store.test.js

import assert from 'node:assert/strict';
import { test } from 'node:test';

const RUN = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

test('FirestoreStore: состояние переживает пересоздание инстанса', { skip: !RUN }, async () => {
  const { FirestoreStore } = await import('../../src/store-firestore.js');
  const config = { firebase: { projectId: process.env.GOOGLE_CLOUD_PROJECT || 'demo-reelio' } };

  const store = await FirestoreStore.create(config);

  // Транзакционная запись задач и счётчика.
  await store.runTransaction(async (t) => {
    await t.putJob({ id: 'an_e1', uid: 'ue', status: 'queued', fingerprint: 'fpe1', projectId: 'pe' });
    await t.putJob({ id: 'an_e2', uid: 'ue', status: 'succeeded', projectId: 'pe' });
    await t.writeCounter('u_ue_2026-01-01', 1);
  });

  // НОВЫЙ инстанс store — состояние на месте (durable, не в памяти процесса).
  const store2 = await FirestoreStore.create(config);
  await store2.runTransaction(async (t) => {
    assert.equal((await t.getJob('an_e1')).status, 'queued');
    assert.equal((await t.findJobByFingerprint('fpe1')).id, 'an_e1');
    assert.equal(await t.countActiveJobs('ue'), 1); // только незавершённая
    assert.equal(await t.readCounter('u_ue_2026-01-01'), 1);
  });
  assert.equal((await store2.getJob('an_e2')).status, 'succeeded');

  // Render job — тот же интерфейс.
  await store2.runTransaction(async (t) => {
    await t.putRenderJob({ id: 'job_e1', uid: 'ue', status: 'running', projectId: 'pe' });
  });
  const store3 = await FirestoreStore.create(config);
  assert.equal((await store3.getRenderJob('job_e1')).status, 'running');
});
