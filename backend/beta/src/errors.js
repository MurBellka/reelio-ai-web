// Структурированные ошибки beta API (§6 долга).
//
// Тот же конверт, что в production (§7 контракта v1): наружу уходит стабильный
// машинный код, человекочитаемое сообщение и признак «имеет ли смысл повтор».
// Ни одно сообщение не содержит секретов, тел ответов Gemini, путей файловой
// системы и стектрейсов — технические детали живут в поле `detail`, которое
// пишется только в лог.

/** Каталог кодов: code → { status, retryable }. */
export const ERROR_CATALOG = {
  INVALID_REQUEST: { status: 400, retryable: false },
  PLAN_INVALID: { status: 400, retryable: false },
  ASSET_MISSING: { status: 400, retryable: false },
  INVALID_OBJECT_PATH: { status: 400, retryable: false },

  UNAUTHENTICATED: { status: 401, retryable: false },
  APP_CHECK_FAILED: { status: 403, retryable: false },
  FORBIDDEN: { status: 403, retryable: false },

  ANALYSIS_NOT_FOUND: { status: 404, retryable: false },
  ANALYSIS_ALREADY_TERMINAL: { status: 409, retryable: false },
  IDEMPOTENCY_KEY_REUSED: { status: 409, retryable: false },

  // Render API (§4B).
  JOB_NOT_FOUND: { status: 404, retryable: false },
  JOB_ALREADY_TERMINAL: { status: 409, retryable: false },
  RESULT_EXPIRED: { status: 410, retryable: false },
  RENDER_NOT_CONFIGURED: { status: 503, retryable: false },
  TOO_MANY_ACTIVE_JOBS: { status: 429, retryable: true },
  RENDER_FAILED: { status: 500, retryable: true },

  LIMIT_EXCEEDED: { status: 400, retryable: false },
  DAILY_LIMIT_REACHED: { status: 429, retryable: false },
  PROJECT_LIMIT_REACHED: { status: 429, retryable: false },
  TOO_MANY_ACTIVE_ANALYSES: { status: 429, retryable: true },
  RATE_LIMITED: { status: 429, retryable: true },

  ANALYSIS_FAILED: { status: 500, retryable: true },
  INTERNAL: { status: 500, retryable: true },
  MODEL_OUTPUT_REJECTED: { status: 502, retryable: true },
  UPSTREAM_FAILED: { status: 502, retryable: true },
  ANALYSIS_UNAVAILABLE: { status: 503, retryable: true },
  TIMEOUT: { status: 504, retryable: true },
  CANCELLED: { status: 499, retryable: false },
};

export class ApiError extends Error {
  constructor(code, message, { field, detail, status, retryable } = {}) {
    super(message);
    const spec = ERROR_CATALOG[code] || ERROR_CATALOG.INTERNAL;
    this.name = 'ApiError';
    this.code = ERROR_CATALOG[code] ? code : 'INTERNAL';
    this.status = status ?? spec.status;
    this.retryable = retryable ?? spec.retryable;
    this.field = field;
    /** Только для лога — наружу не отдаётся. */
    this.detail = detail;
  }

  toBody(requestId) {
    const error = { code: this.code, message: this.message, retryable: this.retryable };
    if (this.field) error.field = this.field;
    if (requestId) error.requestId = requestId;
    return { error };
  }
}

/**
 * Приводит любое исключение к ApiError, не раскрывая внутренностей.
 *
 * Модули анализа бросают свои типы ошибок (LimitExceededError, GeminiError,
 * UnsafeModelOutputError, PlanValidationError) — у всех есть поле `code`,
 * и здесь оно сопоставляется с каталогом. Незнакомая ошибка становится
 * нейтральным INTERNAL: сообщение неизвестного исключения наружу не уходит.
 */
export function toApiError(err) {
  if (err instanceof ApiError) return err;

  if (err?.code && ERROR_CATALOG[err.code]) {
    return new ApiError(err.code, err.message, {
      field: err.field,
      detail: err.detail ?? err.stack,
      retryable: err.retryable,
    });
  }

  // Известные коды из модулей, не совпадающие с каталогом по имени.
  const mapped = {
    GEMINI_NOT_CONFIGURED: 'ANALYSIS_UNAVAILABLE',
    EMPTY_RESPONSE: 'MODEL_OUTPUT_REJECTED',
    MALFORMED_RESPONSE: 'MODEL_OUTPUT_REJECTED',
  }[err?.code];
  if (mapped) {
    return new ApiError(mapped, err.message, { detail: err.stack });
  }

  return new ApiError('INTERNAL', 'Внутренняя ошибка сервера.', {
    detail: err?.stack || String(err?.message || err),
  });
}

/** Express-обработчик: наружу уходит только каталогизированный код. */
export function errorHandler(err, req, res, _next) {
  const api = toApiError(err);
  if (api.status >= 500) {
    // В лог — код и деталь, без тела запроса и без токенов.
    req.log?.error?.('request failed', { code: api.code, detail: api.detail });
  }
  return res.status(api.status).json(api.toBody(req.requestId));
}
