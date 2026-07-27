// Клиент Gemini для анализа (§4, §7, §11, §14 задания).
//
// §14 — ключ читается ТОЛЬКО из переменной окружения (в облаке она приходит из
// Secret Manager). Он не логируется, не возвращается клиенту, не попадает в
// тексты ошибок и не сохраняется в полях этого объекта под именем, которое
// легко случайно сериализовать: доступ к нему идёт через замыкание.
//
// §7 — ответ модели никогда не отдаётся дальше «как есть». Он разбирается
// строгим парсером и валидируется схемой; всё, что не прошло, вызывает повтор
// или ошибку, но не попадает в EditPlan.
//
// §11 — таймаут, ограниченное число повторов и учёт стоимости на каждый вызов.

import { ANALYSIS_LIMITS } from './limits.js';
import { UnsafeModelOutputError, parseModelJson } from './sanitize.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Ошибка обращения к модели. Наружу уходит код, а не тело ответа Gemini. */
export class GeminiError extends Error {
  constructor(code, message, { retryable = false, status = null } = {}) {
    super(message);
    this.name = 'GeminiError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

/** HTTP-статусы, при которых повтор осмыслен. */
function isRetryableStatus(status) {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class GeminiClient {
  /**
   * @param {{apiKey: string, model?: string, fetchImpl?: typeof fetch,
   *          timeoutMs?: number, maxRetries?: number, logger?: object}} opts
   */
  constructor(opts = {}) {
    const apiKey = opts.apiKey ?? '';
    if (!apiKey) {
      throw new GeminiError('GEMINI_NOT_CONFIGURED', 'Анализ недоступен: ИИ не настроен на сервере.');
    }

    // Ключ живёт в замыкании: у объекта нет поля, которое можно случайно
    // залогировать через JSON.stringify(client) или попасть в дамп ошибки.
    this.#authHeader = () => ({ 'x-goog-api-key': apiKey });

    this.model = opts.model ?? 'gemini-2.5-flash';
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? ANALYSIS_LIMITS.geminiTimeoutMs;
    this.maxRetries = opts.maxRetries ?? ANALYSIS_LIMITS.maxGeminiRetries;
    this.logger = opts.logger ?? null;
  }

  /** @type {() => Record<string, string>} */
  #authHeader;

  /**
   * Один вызов с structured output, повторами и таймаутом.
   *
   * @param {{system: string, parts: object[], schema: object, signal?: AbortSignal}} req
   * @returns {Promise<{json: object, usage: object}>}
   */
  async generateJson({ system, parts, schema, signal }) {
    const body = {
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: schema,
        temperature: 0.4,
      },
    };

    let lastError = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (signal?.aborted) {
        throw new GeminiError('CANCELLED', 'Анализ отменён.');
      }
      if (attempt > 0) {
        // Экспоненциальная пауза: 400 мс, 800 мс. Держим её короткой — у
        // анализа есть общий таймаут, и долгое ожидание съест его целиком.
        await sleep(400 * 2 ** (attempt - 1));
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const onOuterAbort = () => controller.abort();
      signal?.addEventListener('abort', onOuterAbort, { once: true });

      try {
        const response = await this.fetchImpl(`${API_BASE}/${this.model}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...this.#authHeader() },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!response.ok) {
          // Тело ошибки Gemini наружу не пробрасываем: там бывают детали
          // квоты и проекта. В лог идёт только статус.
          const retryable = isRetryableStatus(response.status);
          lastError = new GeminiError('UPSTREAM_FAILED', 'Сервис анализа временно недоступен.', {
            retryable,
            status: response.status,
          });
          this.logger?.warn?.('gemini non-2xx', { status: response.status, attempt });
          if (!retryable) throw lastError;
          continue;
        }

        const payload = await response.json();
        const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
        const usage = {
          promptTokens: payload?.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: payload?.usageMetadata?.candidatesTokenCount ?? 0,
        };

        // Пустой ответ — обычно срабатывание фильтров безопасности.
        if (!text) {
          lastError = new GeminiError('EMPTY_RESPONSE', 'Модель вернула пустой ответ.', {
            retryable: true,
          });
          continue;
        }

        // §7: разбор строгий. Мусор — повод повторить, а не «починить».
        try {
          return { json: parseModelJson(text), usage };
        } catch (err) {
          lastError =
            err instanceof UnsafeModelOutputError
              ? new GeminiError('MALFORMED_RESPONSE', 'Модель вернула некорректный ответ.', {
                  retryable: true,
                })
              : err;
          this.logger?.warn?.('gemini malformed json', { attempt });
          continue;
        }
      } catch (err) {
        if (err instanceof GeminiError && !err.retryable) throw err;

        if (err?.name === 'AbortError') {
          if (signal?.aborted) throw new GeminiError('CANCELLED', 'Анализ отменён.');
          lastError = new GeminiError('TIMEOUT', 'Анализ занял слишком много времени.', {
            retryable: true,
          });
          this.logger?.warn?.('gemini timeout', { attempt, timeoutMs: this.timeoutMs });
          continue;
        }

        lastError =
          err instanceof GeminiError
            ? err
            : new GeminiError('UPSTREAM_FAILED', 'Сервис анализа временно недоступен.', {
                retryable: true,
              });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onOuterAbort);
      }
    }

    throw (
      lastError ?? new GeminiError('UPSTREAM_FAILED', 'Сервис анализа временно недоступен.')
    );
  }
}

/**
 * Создаёт клиента из окружения (§14).
 *
 * Ключ приходит из переменной, которую Cloud Run подставляет из Secret Manager.
 * Ни файлов с ключами, ни значений по умолчанию, ни ключа во Flutter.
 */
export function createGeminiClient(env = process.env, opts = {}) {
  return new GeminiClient({
    apiKey: env.GEMINI_API_KEY || '',
    model: env.GEMINI_MODEL || 'gemini-2.5-flash',
    ...opts,
  });
}

/** Настроен ли анализ — для /health, без раскрытия самого ключа. */
export function isGeminiConfigured(env = process.env) {
  return Boolean(env.GEMINI_API_KEY);
}
