// Структурированный логгер для cloud wiring (§ безопасные логи).
//
// Пишет по одной JSON-строке на событие в stdout — Cloud Logging разбирает их в
// структурированные записи (severity + поля). Логгер НЕ логирует секреты: есть
// защитный редактор, который вырезает поля с чувствительными именами (токены,
// signed URL, objectPath, uid, email и пр.) и укорачивает длинные строки. Но
// это лишь страховка — вызывающий код всё равно обязан передавать только
// безопасные поля (errorCode, stage, retryable, jobId).

/** Ключи, значения которых НИКОГДА не попадают в лог (по подстроке имени). */
const REDACT_KEYS = [
  'authorization',
  'token',
  'idtoken',
  'appcheck',
  'secret',
  'password',
  'credential',
  'signedurl',
  'signed_url',
  'downloadurl',
  'uploadurl',
  'objectpath',
  'object_path',
  'filepath',
  'path',
  'uid',
  'email',
  'bearer',
  'apikey',
  'api_key',
  'gemini',
];

const MAX_STR = 500;

function isSensitiveKey(key) {
  const k = String(key).toLowerCase();
  return REDACT_KEYS.some((s) => k.includes(s));
}

/** Рекурсивно чистит поля: секретные ключи → '[redacted]', длинные строки режет. */
function sanitize(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') return value.length > MAX_STR ? `${value.slice(0, MAX_STR)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 4) return '[deep]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitize(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSensitiveKey(k) ? '[redacted]' : sanitize(v, depth + 1);
    }
    return out;
  }
  return '[unloggable]';
}

function emit(severity, message, fields) {
  const record = { severity, message: String(message).slice(0, MAX_STR), ...sanitize(fields ?? {}) };
  record.timestamp = new Date().toISOString();
  try {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(record));
  } catch {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ severity, message: 'log serialization failed' }));
  }
}

/**
 * Структурированный логгер. `info/warn/error(message, fields)` — fields проходят
 * через редактор. Совместим по форме с тем, что ждут сервисы (`logger.warn?.`).
 */
export function createLogger() {
  return {
    info: (message, fields) => emit('INFO', message, fields),
    warn: (message, fields) => emit('WARNING', message, fields),
    error: (message, fields) => emit('ERROR', message, fields),
  };
}
