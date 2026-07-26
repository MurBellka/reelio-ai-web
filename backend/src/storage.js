// Объектное хранилище: Cloud Storage (cloud) или локальный каталог (local).
//
// Signed URL — V4, подпись через IAM signBlob сервисным аккаунтом Cloud Run.
// Ключи сервисных аккаунтов НЕ скачиваются и НЕ хранятся в репозитории (§8, §9).
// Подписанный URL никогда не логируется.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

class GcsStorage {
  constructor(bucket, config) {
    this.bucketName = config.render.bucket;
    this.bucket = bucket;
    this.ttlSeconds = config.render.signedUrlTtlSeconds;
  }

  get mode() {
    return 'cloud';
  }

  uriFor(objectPath) {
    return `gs://${this.bucketName}/${objectPath}`;
  }

  async writeJson(objectPath, value, metadata = {}, { customTime } = {}) {
    await this.bucket.file(objectPath).save(JSON.stringify(value, null, 2), {
      contentType: 'application/json; charset=utf-8',
      resumable: false,
      metadata: {
        cacheControl: 'private, max-age=0, no-transform',
        ...(customTime ? { customTime } : {}),
        metadata,
      },
    });
    return this.uriFor(objectPath);
  }

  /**
   * Проставляет Custom-Time объекта = моменту, после которого его можно
   * удалять. Lifecycle-правило `daysSinceCustomTime` превращает это в точное
   * удаление ровно по `expiresAt` задачи (§6), чего age-правило дать не может:
   * возраст объекта не знает, к какой задаче он относится.
   */
  async setCustomTime(objectPath, customTime) {
    await this.bucket.file(objectPath).setMetadata({ customTime });
  }

  async readJson(objectPath) {
    const [buf] = await this.bucket.file(objectPath).download();
    return JSON.parse(buf.toString('utf8'));
  }

  async exists(objectPath) {
    const [ok] = await this.bucket.file(objectPath).exists();
    return ok;
  }

  async statObject(objectPath) {
    const [meta] = await this.bucket.file(objectPath).getMetadata();
    return {
      sizeBytes: Number(meta.size) || 0,
      contentType: meta.contentType || null,
      checksumCrc32c: meta.crc32c || null,
      updatedAt: meta.updated || null,
    };
  }

  /** V4 signed URL на чтение. Возвращает { url, expiresAt }. */
  async signedReadUrl(objectPath, { fileName, ttlSeconds } = {}) {
    const ttl = (ttlSeconds || this.ttlSeconds) * 1000;
    const expires = Date.now() + ttl;
    const options = { version: 'v4', action: 'read', expires };
    if (fileName) {
      options.responseDisposition = `attachment; filename="${fileName.replace(/"/g, '')}"`;
    }
    const [url] = await this.bucket.file(objectPath).getSignedUrl(options);
    return { url, expiresAt: new Date(expires).toISOString() };
  }

  /** Удаляет всё под префиксом. Возвращает число удалённых объектов. */
  async deletePrefix(prefix) {
    const [files] = await this.bucket.getFiles({ prefix });
    await Promise.all(files.map((f) => f.delete({ ignoreNotFound: true })));
    return files.length;
  }

  /**
   * V4 signed URL на запись одного объекта (§8.2). Подпись привязана к
   * contentType: клиент не сможет залить под этой ссылкой другой тип.
   */
  async signedWriteUrl(objectPath, { contentType, ttlSeconds } = {}) {
    const ttl = (ttlSeconds || this.ttlSeconds) * 1000;
    const expires = Date.now() + ttl;
    const [url] = await this.bucket.file(objectPath).getSignedUrl({
      version: 'v4',
      action: 'write',
      expires,
      contentType,
    });
    return {
      url,
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      expiresAt: new Date(expires).toISOString(),
    };
  }
}

/**
 * Локальное хранилище: та же структура путей, что и в GCS (§6).
 * «Подписанный URL» — ссылка на собственный /download с HMAC-подписью и сроком
 * жизни, чтобы поведение клиента совпадало с облачным.
 */
class LocalStorage {
  constructor(config) {
    this.root = resolve(process.cwd(), config.render.localRoot);
    this.ttlSeconds = config.render.signedUrlTtlSeconds;
    this.baseUrl = config.render.publicBaseUrl || `http://127.0.0.1:${config.port}`;
    this.secret = randomBytes(32);
  }

  get mode() {
    return 'local';
  }

  pathFor(objectPath) {
    const full = resolve(this.root, objectPath);
    // Повторная защита от traversal уже после валидации контракта.
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new Error('object path escapes local render root');
    }
    return full;
  }

  uriFor(objectPath) {
    return `file://${this.pathFor(objectPath)}`;
  }

  async writeJson(objectPath, value) {
    const full = this.pathFor(objectPath);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, JSON.stringify(value, null, 2), 'utf8');
    return this.uriFor(objectPath);
  }

  /** В local mode срок жизни задаёт сам разработчик — правило не нужно. */
  async setCustomTime() {}

  async readJson(objectPath) {
    return JSON.parse(await readFile(this.pathFor(objectPath), 'utf8'));
  }

  async exists(objectPath) {
    try {
      await stat(this.pathFor(objectPath));
      return true;
    } catch {
      return false;
    }
  }

  async statObject(objectPath) {
    const s = await stat(this.pathFor(objectPath));
    return {
      sizeBytes: s.size,
      contentType: objectPath.endsWith('.mp4') ? 'video/mp4' : null,
      checksumCrc32c: null,
      updatedAt: new Date(s.mtimeMs).toISOString(),
    };
  }

  sign(objectPath, expiresMs, scope = 'read') {
    return createHmac('sha256', this.secret)
      .update(`${scope}:${objectPath}:${expiresMs}`)
      .digest('hex');
  }

  verify(objectPath, expiresMs, signature, scope = 'read') {
    if (!expiresMs || Number(expiresMs) < Date.now()) return false;
    const expected = this.sign(objectPath, String(expiresMs), scope);
    return expected.length === String(signature).length &&
      timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature)));
  }

  async deletePrefix(prefix) {
    const full = this.pathFor(prefix.replace(/\/+$/, ''));
    let count = 0;
    try {
      const entries = await readdir(full, { recursive: true, withFileTypes: true });
      count = entries.filter((e) => e.isFile()).length;
    } catch {
      return 0;
    }
    await rm(full, { recursive: true, force: true });
    return count;
  }

  /** Локальный аналог signed write URL: приём байтов через PUT /uploads/file. */
  async signedWriteUrl(objectPath, { contentType, ttlSeconds } = {}) {
    const expires = Date.now() + (ttlSeconds || this.ttlSeconds) * 1000;
    const sig = this.sign(objectPath, String(expires), 'write');
    const q = new URLSearchParams({
      object: objectPath,
      expires: String(expires),
      sig,
      contentType,
    });
    return {
      url: `${this.baseUrl}/uploads/file?${q.toString()}`,
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      expiresAt: new Date(expires).toISOString(),
    };
  }

  /** Приём загруженных байтов (только local mode). */
  async writeBytes(objectPath, buffer) {
    const full = this.pathFor(objectPath);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, buffer);
    return full;
  }

  async signedReadUrl(objectPath, { fileName, ttlSeconds } = {}) {
    const expires = Date.now() + (ttlSeconds || this.ttlSeconds) * 1000;
    const sig = this.sign(objectPath, String(expires));
    const q = new URLSearchParams({ object: objectPath, expires: String(expires), sig });
    if (fileName) q.set('filename', fileName);
    return {
      url: `${this.baseUrl}/download/file?${q.toString()}`,
      expiresAt: new Date(expires).toISOString(),
    };
  }

  localFilePath(objectPath) {
    return join(this.root, objectPath);
  }
}

export async function createStorage(config) {
  if (config.render.mode !== 'cloud') return new LocalStorage(config);
  const { Storage } = await import('@google-cloud/storage');
  // ADC / Workload Identity — никаких файлов ключей.
  const storage = new Storage({ projectId: config.render.gcpProject || undefined });
  return new GcsStorage(storage.bucket(config.render.bucket), config);
}

export { LocalStorage, GcsStorage };
