import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CancelledError } from '../../src/errors.js';
import { ProgressReporter } from '../../src/progress.js';

/** Фейковый fetch, записывающий запросы и отдающий заготовленные ответы. */
function fakeFetch(replies) {
  const calls = [];
  const queue = [...replies];
  const impl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const reply = queue.length > 1 ? queue.shift() : queue[0];
    if (reply instanceof Error) throw reply;
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => reply.body ?? {},
    };
  };
  impl.calls = calls;
  return impl;
}

const silentLogger = { warn() {}, info() {}, error() {}, debug() {} };

function makeReporter(fetchImpl, opts = {}) {
  return new ProgressReporter({
    url: 'https://backend.example/internal/jobs/job_1/progress',
    token: 'secret-worker-token',
    jobId: 'job_1',
    logger: silentLogger,
    fetchImpl,
    ...opts,
  });
}

test('отчёт уходит с Bearer-токеном и телом по §8.1', async () => {
  const impl = fakeFetch([{ status: 200, body: { ok: true, cancelRequested: false } }]);
  const reporter = makeReporter(impl);

  await reporter.report('encoding', 0.4, 'Кодирование 1080p');

  assert.equal(impl.calls.length, 1);
  assert.equal(impl.calls[0].init.method, 'POST');
  assert.equal(impl.calls[0].init.headers.Authorization, 'Bearer secret-worker-token');
  assert.deepEqual(impl.calls[0].body, {
    phase: 'encoding',
    fraction: 0.4,
    message: 'Кодирование 1080p',
  });
});

test('cancelRequested из ответа переводит worker в отмену', async () => {
  const impl = fakeFetch([{ status: 200, body: { ok: true, cancelRequested: true } }]);
  const reporter = makeReporter(impl);

  await reporter.report('rendering', 0.5);
  assert.equal(reporter.cancelRequested, true);
  assert.throws(() => reporter.throwIfCancelled(), CancelledError);
});

test('404 — задача удалена, работать дальше нельзя', async () => {
  const reporter = makeReporter(fakeFetch([{ status: 404 }]));
  await assert.rejects(() => reporter.report('encoding', 0.1), CancelledError);
  assert.equal(reporter.terminated, true);
});

test('409 — задача уже терминальна, worker обязан остановиться', async () => {
  const reporter = makeReporter(fakeFetch([{ status: 409 }]));
  await assert.rejects(() => reporter.report('encoding', 0.1), CancelledError);
  assert.equal(reporter.terminated, true);
});

test('сбой сети не роняет рендер', async () => {
  const reporter = makeReporter(fakeFetch([new Error('ECONNRESET')]));
  const reply = await reporter.report('downloading', 0.5);
  assert.equal(reply.ok, true);
  assert.equal(reporter.cancelRequested, false);
});

test('5xx от backend не роняет рендер', async () => {
  const reporter = makeReporter(fakeFetch([{ status: 503 }]));
  const reply = await reporter.report('downloading', 0.5);
  assert.equal(reply.ok, true);
});

test('fraction зажимается в диапазон 0..1', async () => {
  const impl = fakeFetch([{ status: 200, body: { ok: true } }]);
  const reporter = makeReporter(impl);
  await reporter.report('encoding', 5);
  assert.equal(impl.calls[0].body.fraction, 1);
  await reporter.report('encoding', -3);
  assert.equal(impl.calls[1].body.fraction, 0);
});

test('§4: глобальный прогресс не убывает при откате доли внутри этапа', async () => {
  const impl = fakeFetch([{ status: 200, body: { ok: true } }]);
  const reporter = makeReporter(impl);

  await reporter.report('encoding', 0.8);
  await reporter.report('encoding', 0.3); // FFmpeg дрогнул назад
  await reporter.report('encoding', 0.9);

  assert.equal(impl.calls[0].body.fraction, 0.8);
  assert.equal(impl.calls[1].body.fraction, 0.8, 'откат должен быть выровнен, а не отправлен');
  assert.equal(impl.calls[2].body.fraction, 0.9);
});

test('§4: переход к следующему этапу не считается откатом', async () => {
  const impl = fakeFetch([{ status: 200, body: { ok: true } }]);
  const reporter = makeReporter(impl);

  await reporter.report('downloading', 1);
  await reporter.report('rendering', 0);

  // rendering начинается там, где кончился downloading, — доля 0 корректна.
  assert.equal(impl.calls[1].body.phase, 'rendering');
  assert.equal(impl.calls[1].body.fraction, 0);
});

test('терминальные фазы не выравниваются — прогресс замораживается', async () => {
  const impl = fakeFetch([{ status: 200, body: { ok: true } }]);
  const reporter = makeReporter(impl);

  await reporter.report('encoding', 0.9);
  await reporter.reportFailed({ code: 'WORKER_FAILED', message: 'сбой' });

  assert.equal(impl.calls[1].body.phase, 'failed');
  assert.equal(impl.calls[1].body.fraction, 0);
});

test('неизвестная фаза — ошибка программиста, а не тихая отправка мусора', async () => {
  const reporter = makeReporter(fakeFetch([{ status: 200, body: {} }]));
  await assert.rejects(() => reporter.report('teleporting', 0.5), /INTERNAL|Внутренняя/);
});

test('done несёт RenderResult, failed — объект ошибки', async () => {
  const impl = fakeFetch([{ status: 200, body: { ok: true } }]);
  const reporter = makeReporter(impl);

  await reporter.reportDone({ objectPath: 'projects/p/jobs/j/output/reel_1280p.mp4' });
  assert.equal(impl.calls[0].body.phase, 'done');
  assert.equal(impl.calls[0].body.fraction, 1);
  assert.ok(impl.calls[0].body.result);

  await reporter.reportFailed({ code: 'WORKER_FAILED', message: 'Не удалось собрать видео.' });
  assert.equal(impl.calls[1].body.phase, 'failed');
  assert.equal(impl.calls[1].body.error.code, 'WORKER_FAILED');
});

test('heartbeat повторяет текущую фазу не реже заданного интервала', async () => {
  const impl = fakeFetch([{ status: 200, body: { ok: true } }]);
  const reporter = makeReporter(impl, { heartbeatMs: 20 });

  await reporter.report('encoding', 0.3, 'Кодирование');
  reporter.start();
  await new Promise((resolve) => setTimeout(resolve, 70));
  reporter.stop();

  const heartbeats = impl.calls.slice(1);
  assert.ok(heartbeats.length >= 2, `ожидалось ≥2 heartbeat, получено ${heartbeats.length}`);
  assert.ok(heartbeats.every((c) => c.body.phase === 'encoding'));
});

test('без URL канал молча выключен — local mode остаётся рабочим', async () => {
  const impl = fakeFetch([{ status: 200, body: { ok: true } }]);
  const reporter = new ProgressReporter({ url: '', token: '', jobId: 'j', logger: silentLogger, fetchImpl: impl });

  const reply = await reporter.report('encoding', 0.5);
  assert.equal(reply.ok, true);
  assert.equal(impl.calls.length, 0);
});
