// Долговечная очередь (§4A.7): InlineTaskQueue с повторами и drain,
// CloudTasksQueue без конфигурации — понятная ошибка, и — главное —
// построение ID задачи Cloud Tasks (§4A.6): точка в kind `analysis.run` больше
// не попадает в имя задачи, ID детерминирован и без запрещённых символов.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CloudTasksQueue,
  InlineTaskQueue,
  TASK_ID_MAX_LENGTH,
  buildTaskId,
  isAlreadyExistsError,
} from '../../src/tasks.js';

const TASK_ID_ALLOWED = /^[A-Za-z0-9_-]+$/;

/** Полная валидная cloud-конфигурация очереди. */
function cloudCfg(overrides = {}) {
  return {
    queue: 'reelio-analysis-v2',
    location: 'europe-west1',
    projectId: 'proj-test',
    internalUrl: 'https://reelio-backend-beta-abc-ew.a.run.app',
    oidcAudience: 'https://reelio-backend-beta-abc-ew.a.run.app',
    invokerServiceAccount: 'tasks@proj-test.iam.gserviceaccount.com',
    ...overrides,
  };
}

test('InlineTaskQueue повторяет обработчик до успеха и ждёт drain', async () => {
  const attempts = [];
  const queue = new InlineTaskQueue({
    maxAttempts: 3,
    handler: async ({ attempt, maxAttempts }) => {
      attempts.push(attempt);
      assert.equal(maxAttempts, 3);
      if (attempt < 2) throw new Error('transient');
      // attempt === 2 — успех.
    },
  });

  await queue.enqueue({ jobId: 'j1', kind: 'analysis.run' });
  await queue.drain();
  assert.deepEqual(attempts, [0, 1, 2], 'три попытки: два сбоя и успех');
});

test('InlineTaskQueue не повторяет бесконечно (последняя попытка терминальна)', async () => {
  let count = 0;
  const queue = new InlineTaskQueue({
    maxAttempts: 3,
    handler: async () => {
      count += 1;
      throw new Error('always'); // handler всегда бросает
    },
  });
  await queue.enqueue({ jobId: 'j2' });
  await queue.drain();
  assert.equal(count, 3, 'ровно maxAttempts попыток, дальше — стоп');
});

test('CloudTasksQueue без очереди/URL/SA отказывается ставить задачу', async () => {
  const queue = new CloudTasksQueue({ queue: '', internalUrl: '', invokerServiceAccount: '' });
  await assert.rejects(
    queue.enqueue({ jobId: 'j3', kind: 'analysis.run' }),
    /не сконфигурирована/,
  );
});

// ── §4A.6: построение ID задачи Cloud Tasks ─────────────────────────────────

test('1. analysis.run даёт ID вида analysis-run-…', () => {
  assert.equal(buildTaskId('analysis.run', 'an_01H8XY'), 'analysis-run-an_01H8XY');
  assert.match(buildTaskId('analysis.run', 'an_01H8XY'), /^analysis-run-/);
});

test('2. ID не содержит точки и других запрещённых символов', () => {
  // Именно из-за точки в kind `analysis.run` реальный API давал INVALID_ARGUMENT.
  for (const jobId of ['an_01H8XY', 'AbC-123_xyz', 'weird.id!with#bad$', '', 'жоб']) {
    const id = buildTaskId('analysis.run', jobId);
    assert.ok(!id.includes('.'), `нет точки: ${id}`);
    assert.match(id, TASK_ID_ALLOWED, `только [A-Za-z0-9_-]: ${id}`);
  }
});

test('3. неизвестный kind отклоняется (до обращения к API)', async () => {
  assert.throws(() => buildTaskId('analysis.unknown', 'x'), /Неизвестный тип задачи/);
  assert.throws(() => buildTaskId('', 'x'), /Неизвестный тип задачи/);

  // И на уровне очереди: до реального клиента дело не доходит.
  const client = {
    queuePath: () => 'projects/p/locations/l/queues/q',
    createTask: () => assert.fail('createTask не должен вызываться при неизвестном kind'),
  };
  const queue = new CloudTasksQueue({ ...cloudCfg(), client });
  await assert.rejects(queue.enqueue({ jobId: 'j', kind: 'nope.kind' }), /Неизвестный тип задачи/);
});

test('4. невалидный/слишком длинный jobId безопасно сворачивается в дайджест', () => {
  const long = 'x'.repeat(2000);
  const idLong = buildTaskId('analysis.run', long);
  assert.match(idLong, TASK_ID_ALLOWED);
  assert.ok(idLong.length <= TASK_ID_MAX_LENGTH, `в пределах лимита: ${idLong.length}`);
  assert.match(idLong, /^analysis-run-d_/, 'дайджест с сохранённым префиксом kind');

  const idDots = buildTaskId('analysis.run', 'a.b/c\\d e');
  assert.match(idDots, TASK_ID_ALLOWED);
  assert.match(idDots, /^analysis-run-d_/);

  // Пустой jobId тоже безопасен и детерминирован.
  assert.match(buildTaskId('analysis.run', ''), TASK_ID_ALLOWED);
});

test('5. разные jobId не дают одинаковый ID; прямой и дайджест не сталкиваются', () => {
  const a = buildTaskId('analysis.run', 'an_A');
  const b = buildTaskId('analysis.run', 'an_B');
  assert.notEqual(a, b);

  // Прямой короткий ID и дайджест длинного — заведомо разные (разная форма).
  const direct = buildTaskId('analysis.run', 'an_short');
  const digest = buildTaskId('analysis.run', 'y'.repeat(1000));
  assert.notEqual(direct, digest);
  assert.ok(!direct.startsWith('analysis-run-d_'));
  assert.ok(digest.startsWith('analysis-run-d_'));
});

test('6. повтор (kind, jobId) даёт тот же ID (детерминизм → идемпотентность)', () => {
  assert.equal(buildTaskId('analysis.run', 'an_1'), buildTaskId('analysis.run', 'an_1'));
  const big = 'z'.repeat(5000);
  assert.equal(buildTaskId('analysis.run', big), buildTaskId('analysis.run', big));
});

test('isAlreadyExistsError распознаёт gRPC-код 6 и текстовую форму', () => {
  assert.ok(isAlreadyExistsError({ code: 6 }));
  assert.ok(isAlreadyExistsError({ code: 'ALREADY_EXISTS' }));
  assert.ok(isAlreadyExistsError(new Error('Requested entity already exists')));
  assert.ok(!isAlreadyExistsError({ code: 3 }));
  assert.ok(!isAlreadyExistsError(new Error('invalid argument')));
});

// ── §4A.6: интеграция с адаптером, применяющим реальные ограничения ID ────────
//
// Простого fake `createTask: success` недостаточно (именно поэтому дефект и
// дожил до реального деплоя). Этот адаптер валидирует извлечённый ID задачи по
// тем же правилам, что и Cloud Tasks, ДО того как вернуть фейковый успех, и
// повторную задачу с тем же именем отклоняет как ALREADY_EXISTS.

function cloudTasksAdapter() {
  const names = new Set();
  const created = [];
  return {
    created,
    queuePath(projectId, location, queue) {
      return `projects/${projectId}/locations/${location}/queues/${queue}`;
    },
    taskPath(projectId, location, queue, task) {
      return `projects/${projectId}/locations/${location}/queues/${queue}/tasks/${task}`;
    },
    async createTask({ parent, task }) {
      // Реальное ограничение: имя обязано быть <parent>/tasks/<id>, где id —
      // только [A-Za-z0-9_-], до 500 символов. Иначе — INVALID_ARGUMENT.
      const m = /^(.*)\/tasks\/([^/]+)$/.exec(task.name ?? '');
      if (!m || m[1] !== parent) {
        throw Object.assign(new Error('INVALID_ARGUMENT: task name malformed'), { code: 3 });
      }
      const id = m[2];
      if (!TASK_ID_ALLOWED.test(id) || id.length > TASK_ID_MAX_LENGTH) {
        throw Object.assign(new Error(`INVALID_ARGUMENT: task id "${id}"`), { code: 3 });
      }
      if (names.has(task.name)) {
        throw Object.assign(new Error('Requested entity already exists'), { code: 6 });
      }
      names.add(task.name);
      created.push({ parent, task });
      return [{ name: task.name }];
    },
  };
}

test('7. payload Cloud Tasks несёт корректное полное task name (адаптер валидирует ID)', async () => {
  const client = cloudTasksAdapter();
  const queue = new CloudTasksQueue({ ...cloudCfg(), client });

  const res = await queue.enqueue({ jobId: 'an_01H8XY', kind: 'analysis.run', uid: 'u1' });

  const expected =
    'projects/proj-test/locations/europe-west1/queues/reelio-analysis-v2/tasks/analysis-run-an_01H8XY';
  assert.equal(res.name, expected);
  assert.equal(client.created[0].task.name, expected);
  // ID-часть проходит реальную проверку адаптера (без точки, разрешённые символы).
  assert.match(expected.split('/tasks/')[1], TASK_ID_ALLOWED);
});

test('адаптер отверг бы старое имя с точкой (доказательство, что проверка реальна)', async () => {
  const client = cloudTasksAdapter();
  // Симулируем старое поведение: имя `analysis.run-<jobId>` с точкой.
  const parent = client.queuePath('proj-test', 'europe-west1', 'reelio-analysis-v2');
  await assert.rejects(
    client.createTask({ parent, task: { name: `${parent}/tasks/analysis.run-an_1` } }),
    (err) => err.code === 3,
  );
});

test('11. ALREADY_EXISTS для той же задачи — идемпотентный успех, не 500', async () => {
  const client = cloudTasksAdapter();
  const queue = new CloudTasksQueue({ ...cloudCfg(), client });
  const payload = { jobId: 'an_dup', kind: 'analysis.run', uid: 'u1' };

  const first = await queue.enqueue(payload);
  assert.equal(first.scheduled, true);
  assert.ok(!first.alreadyExists);

  // Тот же (kind, jobId) → тот же детерминированный ID → ALREADY_EXISTS.
  const second = await queue.enqueue(payload);
  assert.equal(second.scheduled, true, 'повтор не бросает — считается успехом');
  assert.equal(second.alreadyExists, true);
  assert.equal(client.created.length, 1, 'вторая задача не создаётся');
});
