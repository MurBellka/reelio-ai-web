import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GeminiClient, GeminiError, createGeminiClient, isGeminiConfigured } from '../../src/gemini.js';

const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } } };

/** Фейковый fetch: очередь ответов, запись запросов. */
function fakeFetch(responses) {
  const calls = [];
  const queue = [...responses];

  const impl = async (url, init) => {
    calls.push({ url, init });
    const next = queue.length > 1 ? queue.shift() : queue[0];

    if (typeof next === 'function') return next(url, init);
    if (next instanceof Error) throw next;

    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body ?? {},
    };
  };
  impl.calls = calls;
  return impl;
}

const okBody = (text, usage = {}) => ({
  status: 200,
  body: {
    candidates: [{ content: { parts: [{ text }] } }],
    usageMetadata: { promptTokenCount: usage.prompt ?? 100, candidatesTokenCount: usage.output ?? 50 },
  },
});

function makeClient(fetchImpl, opts = {}) {
  return new GeminiClient({
    apiKey: 'test-key-not-a-real-secret',
    fetchImpl,
    maxRetries: 2,
    timeoutMs: 200,
    ...opts,
  });
}

const request = { system: 'sys', parts: [{ text: 'hi' }], schema: SCHEMA };

// ── §14: ключ не утекает ──────────────────────────────────────────────────

test('§14: без ключа клиент не создаётся', () => {
  assert.throws(
    () => new GeminiClient({ apiKey: '' }),
    (err) => {
      assert.equal(err.code, 'GEMINI_NOT_CONFIGURED');
      return true;
    },
  );
});

test('§14: ключ уходит в заголовок, но не хранится в полях объекта', async () => {
  const impl = fakeFetch([okBody('{"ok":true}')]);
  const client = makeClient(impl);
  await client.generateJson(request);

  assert.equal(impl.calls[0].init.headers['x-goog-api-key'], 'test-key-not-a-real-secret');

  // Сериализация объекта не должна раскрывать ключ ни под каким именем.
  const serialized = JSON.stringify(client);
  assert.ok(!serialized.includes('test-key-not-a-real-secret'), serialized);
  assert.ok(!Object.keys(client).some((k) => /key|secret|token/i.test(k)));
});

test('§14: ключ не попадает в текст ошибки при сбое', async () => {
  const client = makeClient(fakeFetch([{ status: 403 }]));
  await assert.rejects(
    () => client.generateJson(request),
    (err) => {
      assert.ok(!err.message.includes('test-key-not-a-real-secret'));
      assert.ok(!String(err.stack).includes('test-key-not-a-real-secret'));
      return true;
    },
  );
});

test('§14: клиент читает ключ только из окружения', () => {
  assert.equal(isGeminiConfigured({}), false);
  assert.equal(isGeminiConfigured({ GEMINI_API_KEY: 'x' }), true);
  assert.throws(() => createGeminiClient({}), /GEMINI_NOT_CONFIGURED|не настроен/);
});

// ── §7: некорректный ответ не проходит дальше ─────────────────────────────

test('корректный JSON возвращается вместе с расходом токенов', async () => {
  const client = makeClient(fakeFetch([okBody('{"ok":true}', { prompt: 321, output: 45 })]));
  const { json, usage } = await client.generateJson(request);

  assert.deepEqual(json, { ok: true });
  assert.equal(usage.promptTokens, 321);
  assert.equal(usage.outputTokens, 45);
});

test('markdown-обёртка вокруг JSON разбирается', async () => {
  const client = makeClient(fakeFetch([okBody('```json\n{"ok":true}\n```')]));
  assert.deepEqual((await client.generateJson(request)).json, { ok: true });
});

test('мусор вместо JSON вызывает повтор, затем ошибку', async () => {
  const impl = fakeFetch([okBody('извините, не могу')]);
  const client = makeClient(impl);

  await assert.rejects(
    () => client.generateJson(request),
    (err) => {
      assert.equal(err.code, 'MALFORMED_RESPONSE');
      return true;
    },
  );
  // Первая попытка плюс два повтора.
  assert.equal(impl.calls.length, 3);
});

test('мусор в первой попытке, корректный ответ во второй — успех', async () => {
  const impl = fakeFetch([okBody('не json'), okBody('{"ok":true}')]);
  const client = makeClient(impl);

  assert.deepEqual((await client.generateJson(request)).json, { ok: true });
  assert.equal(impl.calls.length, 2);
});

test('пустой ответ (сработал фильтр безопасности) повторяется', async () => {
  const impl = fakeFetch([{ status: 200, body: { candidates: [] } }]);
  const client = makeClient(impl);

  await assert.rejects(
    () => client.generateJson(request),
    (err) => {
      assert.equal(err.code, 'EMPTY_RESPONSE');
      return true;
    },
  );
  assert.equal(impl.calls.length, 3);
});

// ── §11: таймауты и повторы ───────────────────────────────────────────────

test('таймаут вызова прерывает запрос и повторяет', async () => {
  // Настоящий fetch отменяется по signal — фейковый обязан вести себя так же,
  // иначе тест просто повиснет вместо проверки таймаута.
  const slow = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener(
        'abort',
        () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        { once: true },
      );
    });
  const client = makeClient(fakeFetch([slow]), { timeoutMs: 60, maxRetries: 1 });

  await assert.rejects(
    () => client.generateJson(request),
    (err) => {
      assert.equal(err.code, 'TIMEOUT');
      assert.equal(err.retryable, true);
      return true;
    },
  );
});

test('5xx повторяется, 4xx — нет', async () => {
  const retryable = fakeFetch([{ status: 503 }]);
  await assert.rejects(() => makeClient(retryable).generateJson(request));
  assert.equal(retryable.calls.length, 3, '503 должен повторяться');

  const fatal = fakeFetch([{ status: 400 }]);
  await assert.rejects(() => makeClient(fatal).generateJson(request));
  assert.equal(fatal.calls.length, 1, '400 повторять бессмысленно');
});

test('429 считается повторяемым', async () => {
  const impl = fakeFetch([{ status: 429 }, okBody('{"ok":true}')]);
  assert.deepEqual((await makeClient(impl).generateJson(request)).json, { ok: true });
});

test('тело ошибки Gemini наружу не пробрасывается', async () => {
  // Тело ошибки Gemini содержит идентификатор проекта и детали квоты — ровно
  // то, что не должно доехать до клиента. Значение здесь синтетическое.
  const leak = 'project quota for example-project-000 exceeded';
  const impl = fakeFetch([{ status: 500, body: { error: { message: leak } } }]);

  await assert.rejects(
    () => makeClient(impl).generateJson(request),
    (err) => {
      assert.ok(!err.message.includes('example-project-000'));
      assert.ok(!err.message.includes('quota'));
      assert.equal(err.code, 'UPSTREAM_FAILED');
      return true;
    },
  );
});

test('число повторов ограничено настройкой', async () => {
  const impl = fakeFetch([{ status: 503 }]);
  await assert.rejects(() => makeClient(impl, { maxRetries: 0 }).generateJson(request));
  assert.equal(impl.calls.length, 1);
});

// ── §12: отмена ───────────────────────────────────────────────────────────

test('отмена через AbortSignal прекращает повторы', async () => {
  const controller = new AbortController();
  const impl = fakeFetch([
    () => {
      controller.abort();
      return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    },
  ]);

  await assert.rejects(
    () => makeClient(impl).generateJson({ ...request, signal: controller.signal }),
    (err) => {
      assert.equal(err.code, 'CANCELLED');
      return true;
    },
  );
  assert.equal(impl.calls.length, 1, 'после отмены повторов быть не должно');
});

test('уже отменённый сигнал не даёт сделать ни одного вызова', async () => {
  const controller = new AbortController();
  controller.abort();
  const impl = fakeFetch([okBody('{"ok":true}')]);

  await assert.rejects(
    () => makeClient(impl).generateJson({ ...request, signal: controller.signal }),
    GeminiError,
  );
  assert.equal(impl.calls.length, 0);
});

// ── Форма запроса ─────────────────────────────────────────────────────────

test('запрос уходит со structured output и заданной схемой', async () => {
  const impl = fakeFetch([okBody('{"ok":true}')]);
  await makeClient(impl).generateJson(request);

  const body = JSON.parse(impl.calls[0].init.body);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(body.generationConfig.responseSchema, SCHEMA);
  assert.equal(body.system_instruction.parts[0].text, 'sys');
});
