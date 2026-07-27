// Объектное хранилище: gs:// (Cloud Storage) и file:// (local mode, §10).
//
// Реализация на голом fetch, без @google-cloud/storage: у образа worker'а не
// должно быть зависимостей, которые нужно тянуть при сборке, а прав ему по §9
// выдан ровно один бакет. Аутентификация — только ADC/Workload Identity через
// метаданные инстанса; ключи сервисных аккаунтов не используются и не хранятся.

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

import { Crc32c } from './crc32c.js';
import { WorkerError } from './errors.js';
import { registerSecret } from './logger.js';

const GCS_API = 'https://storage.googleapis.com';
const METADATA_HOST = process.env.GCE_METADATA_HOST || 'metadata.google.internal';

function storageError(message, detail) {
  return new WorkerError('WORKER_FAILED', message, { detail });
}

/** Считает crc32c и размер файла на диске. */
async function fileDigest(filePath) {
  const hash = new Crc32c();
  let sizeBytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    sizeBytes += chunk.length;
    hash.update(chunk);
  }
  return { sizeBytes, crc32c: hash.base64() };
}

// ── Локальный режим (§10) ─────────────────────────────────────────────────

/**
 * Файловое хранилище с той же структурой путей (§6). Корень —
 * ${LOCAL_RENDER_ROOT}; объект `projects/a/b.mp4` лежит в `<root>/projects/a/b.mp4`.
 */
export class LocalStorage {
  constructor(root) {
    this.mode = 'local';
    this.root = root;
  }

  #resolve(objectPath) {
    const full = path.resolve(this.root, objectPath);
    // Вторая линия защиты от traversal: путь обязан остаться под корнем.
    if (full !== this.root && !full.startsWith(`${this.root}${path.sep}`)) {
      throw new WorkerError('INVALID_OBJECT_PATH', 'Путь объекта вне каталога проекта.', {
        detail: 'local path escapes root',
      });
    }
    return full;
  }

  async readJson(objectPath) {
    const full = this.#resolve(objectPath);
    let text;
    try {
      text = await readFile(full, 'utf8');
    } catch (err) {
      throw storageError('Не удалось прочитать монтажный план.', `read failed: ${err.code}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new WorkerError('PLAN_INVALID', 'Монтажный план повреждён.', {
        detail: 'plan.json is not valid JSON',
      });
    }
  }

  async download(objectPath, destPath) {
    const full = this.#resolve(objectPath);
    await mkdir(path.dirname(destPath), { recursive: true });
    try {
      await pipeline(createReadStream(full), createWriteStream(destPath));
    } catch (err) {
      throw new WorkerError('SOURCE_UNREADABLE', 'Не удалось прочитать исходный материал.', {
        detail: `local download failed: ${err.code}`,
      });
    }
    return fileDigest(destPath);
  }

  async upload(srcPath, objectPath) {
    const full = this.#resolve(objectPath);
    await mkdir(path.dirname(full), { recursive: true });
    await pipeline(createReadStream(srcPath), createWriteStream(full));
    return fileDigest(full);
  }

  async writeText(objectPath, text) {
    const full = this.#resolve(objectPath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, text, 'utf8');
    return { sizeBytes: Buffer.byteLength(text), crc32c: null };
  }

  async removePrefix(prefix) {
    const full = this.#resolve(prefix);
    await rm(full, { recursive: true, force: true });
  }
}

// ── Cloud Storage ─────────────────────────────────────────────────────────

/** Токен доступа из метаданных инстанса (ADC/Workload Identity). */
class MetadataToken {
  constructor(fetchImpl) {
    this.fetchImpl = fetchImpl;
    this.token = '';
    this.expiresAt = 0;
  }

  async get() {
    // Обновляем за минуту до истечения, чтобы длинная выгрузка не упала.
    if (this.token && Date.now() < this.expiresAt - 60_000) return this.token;

    const url = `http://${METADATA_HOST}/computeMetadata/v1/instance/service-accounts/default/token`;
    const response = await this.fetchImpl(url, { headers: { 'Metadata-Flavor': 'Google' } });
    if (!response.ok) {
      throw storageError('Нет доступа к хранилищу.', `metadata token status ${response.status}`);
    }
    const body = await response.json();
    if (!body?.access_token) {
      throw storageError('Нет доступа к хранилищу.', 'metadata token missing access_token');
    }
    this.token = body.access_token;
    registerSecret(this.token);
    this.expiresAt = Date.now() + (Number(body.expires_in) || 3600) * 1000;
    return this.token;
  }
}

export class GcsStorage {
  /** @param {string} bucket @param {{fetchImpl?: typeof fetch}} [opts] */
  constructor(bucket, opts = {}) {
    this.mode = 'cloud';
    this.bucket = bucket;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.tokens = opts.tokenProvider ?? new MetadataToken(this.fetchImpl);
  }

  async #authHeaders(extra = {}) {
    return { Authorization: `Bearer ${await this.tokens.get()}`, ...extra };
  }

  #objectUrl(objectPath, query = '') {
    return `${GCS_API}/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(
      objectPath,
    )}${query}`;
  }

  async readJson(objectPath) {
    const response = await this.fetchImpl(this.#objectUrl(objectPath, '?alt=media'), {
      headers: await this.#authHeaders(),
    });
    if (!response.ok) {
      throw storageError('Не удалось прочитать монтажный план.', `GET plan status ${response.status}`);
    }
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new WorkerError('PLAN_INVALID', 'Монтажный план повреждён.', {
        detail: 'plan.json is not valid JSON',
      });
    }
  }

  async download(objectPath, destPath) {
    const response = await this.fetchImpl(this.#objectUrl(objectPath, '?alt=media'), {
      headers: await this.#authHeaders(),
    });
    if (!response.ok) {
      // 404 на исходник — это именно «материал не читается», а не сбой сети.
      const code = response.status === 404 ? 'SOURCE_UNREADABLE' : 'WORKER_FAILED';
      throw new WorkerError(code, 'Не удалось загрузить исходный материал.', {
        detail: `GET object status ${response.status}`,
      });
    }
    await mkdir(path.dirname(destPath), { recursive: true });
    await pipeline(Readable.fromWeb(response.body), createWriteStream(destPath));
    return fileDigest(destPath);
  }

  /**
   * Возобновляемая загрузка: MP4 в 4K может быть сотнями мегабайт, простой
   * multipart-upload для этого не годится.
   */
  async upload(srcPath, objectPath, opts = {}) {
    const { size } = await stat(srcPath);
    const metadata = {
      name: objectPath,
      contentType: opts.contentType || 'application/octet-stream',
      cacheControl: opts.cacheControl || 'private, max-age=0, no-transform',
      ...(opts.metadata ? { metadata: opts.metadata } : {}),
    };

    const startUrl = `${GCS_API}/upload/storage/v1/b/${encodeURIComponent(
      this.bucket,
    )}/o?uploadType=resumable&name=${encodeURIComponent(objectPath)}`;

    const start = await this.fetchImpl(startUrl, {
      method: 'POST',
      headers: await this.#authHeaders({
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': metadata.contentType,
        'X-Upload-Content-Length': String(size),
      }),
      body: JSON.stringify(metadata),
    });
    if (!start.ok) {
      throw storageError('Не удалось выгрузить результат.', `resumable start status ${start.status}`);
    }
    const sessionUri = start.headers.get('location');
    if (!sessionUri) {
      throw storageError('Не удалось выгрузить результат.', 'resumable start without location');
    }

    const upload = await this.fetchImpl(sessionUri, {
      method: 'PUT',
      headers: { 'Content-Type': metadata.contentType, 'Content-Length': String(size) },
      body: Readable.toWeb(createReadStream(srcPath)),
      duplex: 'half',
    });
    if (!upload.ok) {
      throw storageError('Не удалось выгрузить результат.', `resumable put status ${upload.status}`);
    }

    const local = await fileDigest(srcPath);
    const remote = await upload.json().catch(() => ({}));
    // Сверяем то, что записал GCS, с тем, что мы отправили.
    if (remote?.crc32c && remote.crc32c !== local.crc32c) {
      throw storageError('Результат выгружен с ошибкой.', 'crc32c mismatch after upload');
    }
    return { sizeBytes: local.sizeBytes, crc32c: remote?.crc32c || local.crc32c };
  }

  async writeText(objectPath, text, opts = {}) {
    const url = `${GCS_API}/upload/storage/v1/b/${encodeURIComponent(
      this.bucket,
    )}/o?uploadType=media&name=${encodeURIComponent(objectPath)}`;
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: await this.#authHeaders({
        'Content-Type': opts.contentType || 'text/plain; charset=utf-8',
      }),
      body: text,
    });
    if (!response.ok) {
      throw storageError('Не удалось записать объект.', `media upload status ${response.status}`);
    }
    return { sizeBytes: Buffer.byteLength(text), crc32c: null };
  }

  /** Удаляет все объекты с префиксом — используется для очистки tmp/ (§6). */
  async removePrefix(prefix) {
    let pageToken = '';
    do {
      const listUrl = `${GCS_API}/storage/v1/b/${encodeURIComponent(
        this.bucket,
      )}/o?prefix=${encodeURIComponent(prefix)}&fields=items(name),nextPageToken${
        pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''
      }`;
      const response = await this.fetchImpl(listUrl, { headers: await this.#authHeaders() });
      if (!response.ok) return; // Очистка — best effort, рендер уже успешен.

      const body = await response.json().catch(() => ({}));
      for (const item of body.items ?? []) {
        await this.fetchImpl(this.#objectUrl(item.name), {
          method: 'DELETE',
          headers: await this.#authHeaders(),
        }).catch(() => {});
      }
      pageToken = body.nextPageToken ?? '';
    } while (pageToken);
  }
}

/** Выбирает бэкенд по режиму из loadEnv(). */
export function createStorage(env, opts = {}) {
  if (env.mode === 'local') return new LocalStorage(env.localRoot);
  if (!env.bucket) {
    throw storageError('Хранилище рендера не настроено.', 'cloud mode without bucket');
  }
  return new GcsStorage(env.bucket, opts);
}
