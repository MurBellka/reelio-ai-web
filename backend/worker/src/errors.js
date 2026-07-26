// Ошибки worker'а в кодах §7 контракта.
//
// Правило безопасности: `message` уходит в RenderJob.error и виден пользователю,
// поэтому в него не попадают пути файловой системы, командные строки FFmpeg,
// токены, signed URL и стектрейсы. Технические детали живут в `detail` и идут
// только в worker.log.

/** Коды §7, которые worker имеет право ставить сам. */
export const WORKER_ERROR_CODES = new Set([
  'WORKER_FAILED',
  'SOURCE_UNREADABLE',
  'CANCELLED_BY_USER',
  'PLAN_INVALID',
  'ASSET_MISSING',
  'INVALID_OBJECT_PATH',
  'RESOLUTION_UNSUPPORTED',
  'DURATION_EXCEEDED',
  'CONTRACT_VERSION_UNSUPPORTED',
  'INVALID_REQUEST',
  'INTERNAL',
]);

/** retryable по каталогу §7. */
const RETRYABLE = new Set(['WORKER_FAILED', 'WORKER_TIMEOUT', 'INTERNAL', 'UPSTREAM_FAILED']);

export class WorkerError extends Error {
  /**
   * @param {string} code код §7
   * @param {string} message безопасный текст для пользователя (ru)
   * @param {{field?: string, detail?: string, cause?: unknown}} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message);
    this.name = 'WorkerError';
    this.code = WORKER_ERROR_CODES.has(code) ? code : 'INTERNAL';
    this.retryable = RETRYABLE.has(this.code);
    this.field = opts.field;
    /** Только для worker.log — наружу не отдаётся. */
    this.detail = opts.detail;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }

  /** Объект ошибки для §8.1 (`error` в теле progress-запроса). */
  toWireError() {
    const error = { code: this.code, message: this.message, retryable: this.retryable };
    if (this.field) error.field = this.field;
    return error;
  }
}

/** Отмена — не ошибка пайплайна, а штатный выход. */
export class CancelledError extends Error {
  constructor(message = 'Рендер отменён пользователем.') {
    super(message);
    this.name = 'CancelledError';
    this.code = 'CANCELLED_BY_USER';
  }
}

/**
 * Приводит произвольное исключение к WorkerError, не раскрывая внутренностей.
 * Сообщение неизвестной ошибки заменяется на нейтральное.
 */
export function toWorkerError(err) {
  if (err instanceof WorkerError) return err;
  if (err instanceof CancelledError) return err;
  return new WorkerError('INTERNAL', 'Внутренняя ошибка рендера.', {
    detail: err?.stack || String(err?.message || err),
    cause: err,
  });
}
