// Логгер worker'а: stdout (Cloud Logging) + буфер, который выгружается в
// projects/{projectId}/jobs/{jobId}/logs/worker.log.
//
// §8 контракта: signed URL никогда не пишется в логи. §9: REELIO_WORKER_TOKEN не
// попадает в логи. Поэтому каждая строка проходит через redact().

/** Строки-секреты, которые вырезаются из любого сообщения. */
const secrets = new Set();

/** Регистрирует значение как секрет: дальше оно всегда заменяется на «***». */
export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 8) secrets.add(value);
}

const SIGNED_URL_RE = /https?:\/\/[^\s"']*(?:X-Goog-Signature|Signature=|GoogleAccessId|X-Amz-Signature)[^\s"']*/gi;
const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const GCS_TOKEN_RE = /ya29\.[A-Za-z0-9._-]+/g;

/** Убирает из строки секреты, подписанные URL и bearer-токены. */
export function redact(input) {
  let text = typeof input === 'string' ? input : String(input);
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join('***');
  }
  text = text.replace(SIGNED_URL_RE, '<signed-url>');
  text = text.replace(BEARER_RE, 'Bearer ***');
  text = text.replace(GCS_TOKEN_RE, '***');
  return text;
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  /** @param {{level?: string, maxBufferBytes?: number, sink?: (line: string) => void}} [opts] */
  constructor(opts = {}) {
    this.level = LEVELS[opts.level] ?? LEVELS.info;
    this.maxBufferBytes = opts.maxBufferBytes ?? 512 * 1024;
    this.sink = opts.sink ?? ((line) => process.stdout.write(`${line}\n`));
    /** @type {string[]} */
    this.buffer = [];
    this.bufferBytes = 0;
    this.truncated = false;
    this.context = {};
  }

  /** Поля, добавляемые к каждой записи (jobId, projectId, attempt). */
  withContext(context) {
    this.context = { ...this.context, ...context };
    return this;
  }

  #write(level, message, fields) {
    if (LEVELS[level] < this.level) return;
    const entry = {
      severity: level.toUpperCase(),
      time: new Date().toISOString(),
      message: redact(message),
      ...this.context,
    };
    if (fields && typeof fields === 'object') {
      for (const [k, v] of Object.entries(fields)) {
        entry[k] = typeof v === 'string' ? redact(v) : v;
      }
    }
    const line = JSON.stringify(entry);
    this.sink(line);

    if (!this.truncated) {
      this.bufferBytes += line.length + 1;
      if (this.bufferBytes > this.maxBufferBytes) {
        this.truncated = true;
        this.buffer.push('{"severity":"WARN","message":"log truncated"}');
      } else {
        this.buffer.push(line);
      }
    }
  }

  debug(message, fields) {
    this.#write('debug', message, fields);
  }

  info(message, fields) {
    this.#write('info', message, fields);
  }

  warn(message, fields) {
    this.#write('warn', message, fields);
  }

  error(message, fields) {
    this.#write('error', message, fields);
  }

  /** Содержимое worker.log для выгрузки в бакет. */
  dump() {
    return `${this.buffer.join('\n')}\n`;
  }
}
