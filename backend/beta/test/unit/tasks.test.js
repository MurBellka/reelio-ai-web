// Долговечная очередь (§4A.7): InlineTaskQueue с повторами и drain,
// CloudTasksQueue без конфигурации — понятная ошибка.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CloudTasksQueue, InlineTaskQueue } from '../../src/tasks.js';

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
