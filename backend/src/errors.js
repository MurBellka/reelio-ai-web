// Единый формат ошибок API — см. docs/render-contract.md §7.
//
// Ни одно сообщение не должно содержать секретов, тел ответов Gemini/GCP,
// подписанных URL или стектрейсов.

/** Каталог кодов: code → { status, retryable }. */
export const ERROR_CATALOG = {
  INVALID_REQUEST: { status: 400, retryable: false },
  CONTRACT_VERSION_UNSUPPORTED: { status: 400, retryable: false },
  PLAN_INVALID: { status: 400, retryable: false },
  ASSET_MISSING: { status: 400, retryable: false },
  INVALID_OBJECT_PATH: { status: 400, retryable: false },
  RESOLUTION_UNSUPPORTED: { status: 400, retryable: false },
  DURATION_EXCEEDED: { status: 400, retryable: false },
  UNAUTHENTICATED: { status: 401, retryable: false },
  FORBIDDEN: { status: 403, retryable: false },
  JOB_NOT_FOUND: { status: 404, retryable: false },
  RESULT_NOT_READY: { status: 404, retryable: true },
  IDEMPOTENCY_KEY_REUSED: { status: 409, retryable: false },
  JOB_ALREADY_TERMINAL: { status: 409, retryable: false },
  RESULT_EXPIRED: { status: 410, retryable: false },
  TOO_MANY_ACTIVE_JOBS: { status: 429, retryable: true },
  RATE_LIMITED: { status: 429, retryable: true },
  INTERNAL: { status: 500, retryable: true },
  UPSTREAM_FAILED: { status: 502, retryable: true },
  RENDER_UNAVAILABLE: { status: 503, retryable: true },

  // Живут только внутри RenderJob.error, HTTP-статуса не имеют.
  WORKER_TIMEOUT: { status: 500, retryable: true },
  WORKER_FAILED: { status: 500, retryable: true },
  SOURCE_UNREADABLE: { status: 500, retryable: false },
  CANCELLED_BY_USER: { status: 409, retryable: false },
};

export class ApiError extends Error {
  constructor(code, message, { field, jobId, status, retryable } = {}) {
    super(message);
    const spec = ERROR_CATALOG[code] || ERROR_CATALOG.INTERNAL;
    this.name = 'ApiError';
    this.code = ERROR_CATALOG[code] ? code : 'INTERNAL';
    this.status = status ?? spec.status;
    this.retryable = retryable ?? spec.retryable;
    this.field = field;
    this.jobId = jobId;
  }

  /** Тело ответа по контракту §7. */
  toBody(requestId) {
    const error = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.field) error.field = this.field;
    if (this.jobId) error.jobId = this.jobId;
    if (requestId) error.requestId = requestId;
    return { error };
  }
}

/** Ошибка внутри RenderJob (без HTTP-обёртки). */
export function jobError(code, message, extra = {}) {
  const spec = ERROR_CATALOG[code] || ERROR_CATALOG.INTERNAL;
  return {
    code: ERROR_CATALOG[code] ? code : 'INTERNAL',
    message,
    retryable: spec.retryable,
    ...extra,
  };
}

/** Express error-handler: наружу уходит только каталогизированный код. */
export function errorHandler(err, req, res, _next) {
  const requestId = req.requestId;
  if (err instanceof ApiError) {
    return res.status(err.status).json(err.toBody(requestId));
  }
  // CORS и парсер тела бросают обычные Error — не раскрываем детали.
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    const e = new ApiError('INVALID_REQUEST', 'Тело запроса не является корректным JSON.');
    return res.status(e.status).json(e.toBody(requestId));
  }
  if (err?.message === 'Origin not allowed') {
    const e = new ApiError('FORBIDDEN', 'Источник запроса не разрешён.');
    return res.status(e.status).json(e.toBody(requestId));
  }
  console.error(`[${requestId}] unhandled:`, err?.code || err?.name || 'Error');
  const e = new ApiError('INTERNAL', 'Внутренняя ошибка сервера.');
  return res.status(e.status).json(e.toBody(requestId));
}
