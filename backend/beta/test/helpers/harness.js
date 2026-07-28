// Обвязка для тестов HTTP-слоя: поднимает приложение без Firebase, без
// облака и без настоящих обращений к Gemini.

import { once } from 'node:events';
import http from 'node:http';

import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';

/**
 * Фейковый Gemini: считает вызовы и отдаёт заготовленный анализ.
 * Именно счётчик вызовов доказывает §4 — повтор не должен его увеличивать.
 */
export function fakeGemini(overrides = {}) {
  const calls = [];

  return {
    model: 'fake-model',
    calls,
    async generateJson({ system, parts, schema, signal }) {
      calls.push({ system, parts, schema });
      if (overrides.fail) throw overrides.fail;
      if (signal?.aborted) {
        const err = new Error('cancelled');
        err.code = 'CANCELLED';
        throw err;
      }
      if (overrides.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, overrides.delayMs));
      }

      // Речевая схема отличается наличием segments — по ней и различаем вызов.
      const isSpeech = Boolean(schema?.properties?.segments);
      const json = isSpeech
        ? overrides.speech ?? { language: 'ru', segments: [{ start: 0.5, end: 2, text: 'Привет' }] }
        : overrides.analysis ?? {
            summary: 'тестовый материал',
            quality: { overall: 0.8, sharpness: 0.7, exposure: 0.6, stability: 0.9 },
            scenes: [{ start: 0, end: 5, shotType: 'wide', motion: 'slow', quality: 0.8 }],
            subjects: [
              { kind: 'person', box: { x: 0.3, y: 0.2, width: 0.4, height: 0.5 }, isPrimary: true },
            ],
            moments: [{ start: 1, end: 4, kind: 'highlight', score: 0.9 }],
            issues: [],
          };

      return { json, usage: { promptTokens: 100, outputTokens: 50 } };
    },
  };
}

/**
 * Фейковый доступ к материалам. Возвращает измеренные характеристики и
 * «кадры» без запуска FFmpeg — HTTP-слой не должен от него зависеть.
 *
 * contentHash берётся из objectPath, чтобы тест мог управлять попаданием в
 * кэш: одинаковый путь — одинаковое содержимое.
 */
export function fakeMedia(overrides = {}) {
  const measured = [];

  return {
    measured,
    async measure(asset) {
      measured.push(asset.id);
      if (overrides.measureFail) throw overrides.measureFail;
      return {
        contentHash: overrides.contentHashFor?.(asset) ?? `hash-of-${asset.objectPath}`,
        durationSeconds: asset.durationSeconds ?? 10,
        width: 1080,
        height: 1920,
        hasAudio: asset.type === 'video',
        scenes: [{ start: 0, end: 5 }],
        quality: { sharpness: 0.7, exposure: 0.6, motion: 0.3 },
      };
    },
    async sample(asset, measuredInfo) {
      return {
        frames: [{ mimeType: 'image/jpeg', data: 'ZmFrZQ==' }],
        audio: measuredInfo.hasAudio ? { mimeType: 'audio/mp4', data: 'ZmFrZQ==' } : null,
        audioSeconds: measuredInfo.hasAudio ? 30 : 0,
      };
    },
  };
}

/** Верификатор, принимающий предсказуемые токены вида `token:<uid>`. */
export function fakeVerifier({ appCheckOk = true } = {}) {
  return {
    async verifyIdToken(token) {
      const match = /^token:(.+)$/.exec(token);
      if (!match) throw Object.assign(new Error('invalid'), { code: 'auth/argument-error' });
      return { uid: match[1], emailVerified: true };
    },
    async verifyAppCheckToken(token) {
      if (!appCheckOk || token !== 'appcheck-ok') {
        throw Object.assign(new Error('invalid'), { code: 'appcheck/invalid' });
      }
      return { appId: 'test-app' };
    },
  };
}

/** Поднимает сервер на случайном порту и даёт удобный клиент. */
export async function startServer(overrides = {}) {
  const defaults = loadConfig({ ALLOW_INSECURE_AUTH: 'false' });
  // Слияние поверхностное, но по секциям: тест, задающий только limits, не
  // должен терять auth и cors.
  const config = {
    ...defaults,
    ...overrides.config,
    auth: { ...defaults.auth, ...overrides.config?.auth },
    limits: { ...defaults.limits, ...overrides.config?.limits },
    cors: overrides.config?.cors ?? defaults.cors,
  };

  // Аргументы перечисляются явно: `...overrides` в конце затирал бы уже
  // слитую конфигурацию сырым overrides.config.
  const built = await createApp({
    config,
    verifier: overrides.verifier ?? fakeVerifier(),
    gemini: overrides.gemini ?? fakeGemini(),
    media: overrides.media ?? fakeMedia(),
    store: overrides.store,
    service: overrides.service,
    logger: overrides.logger,
    taskQueue: overrides.taskQueue,
    oidcVerifier: overrides.oidcVerifier,
  });

  const server = http.createServer(built.app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(method, path, { body, uid = 'user_1', appCheck = 'appcheck-ok', headers = {} } = {}) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(uid ? { Authorization: `Bearer token:${uid}` } : {}),
        ...(appCheck ? { 'X-Firebase-AppCheck': appCheck } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : null,
      headers: response.headers,
    };
  }

  return {
    ...built,
    base,
    request,
    async close() {
      server.close();
      await once(server, 'close');
    },
  };
}

/** Ждёт, пока анализ дойдёт до терминального статуса. */
export async function waitForTerminal(harness, analysisId, uid = 'user_1', timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await harness.request('GET', `/analysis/${analysisId}`, { uid });
    const status = res.body?.analysis?.status;
    if (status && ['succeeded', 'failed', 'cancelled'].includes(status)) return res.body.analysis;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('анализ не завершился за отведённое время');
}

/** Валидные материалы внутри префикса пользователя. */
export function assetsFor(uid = 'user_1', projectId = 'proj_1', count = 1) {
  return Array.from({ length: count }, (_, i) => ({
    id: `asset_${i + 1}`,
    type: 'video',
    objectPath: `users/${uid}/projects/${projectId}/sources/asset_${i + 1}.mp4`,
    durationSeconds: 10,
  }));
}
