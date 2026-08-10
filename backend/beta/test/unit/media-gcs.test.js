// Cloud media adapter (§ фикс media=undefined в cloud): скачивание из GCS +
// проверки + очистка. Fake GCS + подменённые local-analysis функции — без
// реального ffmpeg и без облака.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { assertMediaForMode, createGcsMedia, createMediaForMode } from '../../src/media.js';
import { fakeGemini, fakeVerifier } from '../helpers/harness.js';

const UID = 'user_1';
const PROJECT = 'proj_1';
const OBJECT = `users/${UID}/projects/${PROJECT}/sources/asset_a.mp4`;

/** Fake GCS storage. objects: {path: {bytes, contentType, generation, hang?, streamCode?, streamBytes?}} */
function fakeStorage(objects, spy = {}) {
  spy.buckets = spy.buckets ?? [];
  spy.reads = spy.reads ?? [];
  return {
    bucket(name) {
      spy.buckets.push(name);
      return {
        file(objectPath, opts = {}) {
          const obj = objects[objectPath];
          return {
            async getMetadata() {
              if (!obj) {
                const e = new Error('Not Found');
                e.code = 404;
                throw e;
              }
              return [
                {
                  size: String(obj.metaSize ?? obj.bytes.length),
                  contentType: obj.contentType ?? 'video/mp4',
                  generation: obj.generation ?? '1',
                },
              ];
            },
            createReadStream() {
              spy.reads.push({ objectPath, generation: opts.generation });
              const r = new Readable({ read() {} });
              queueMicrotask(() => {
                if (!obj) {
                  const e = new Error('Not Found');
                  e.code = 404;
                  r.destroy(e);
                  return;
                }
                // pinned generation исчез → 404.
                if (opts.generation && String(opts.generation) !== String(obj.generation ?? '1')) {
                  const e = new Error('generation gone');
                  e.code = 404;
                  r.destroy(e);
                  return;
                }
                if (obj.streamCode) {
                  const e = new Error('stream error');
                  e.code = obj.streamCode;
                  r.destroy(e);
                  return;
                }
                if (obj.hang) return; // никогда не завершается — для отмены/таймаута
                r.push(obj.streamBytes ?? obj.bytes);
                r.push(null);
              });
              return r;
            },
          };
        },
      };
    },
  };
}

/** Подменённые local-analysis функции (успех), с записью вызовов. */
function fakeAnalysis(calls = {}) {
  return {
    calls,
    analysis: {
      async probeAsset(_ffprobe, srcPath, opts) {
        (calls.probe = calls.probe ?? []).push({ srcPath, signal: opts?.signal });
        return { durationSeconds: 10, width: 1080, height: 1920, hasAudio: true, rotation: 0, fps: 30 };
      },
      async detectSceneCuts(_ffmpeg, _src, opts) {
        (calls.scenes = calls.scenes ?? []).push({ signal: opts?.signal });
        return [3, 6];
      },
      // cutsToScenes/selectKeyframeTimes — оставляем НАСТОЯЩИЕ (чистые функции).
      async measureQuality() {
        return { sharpness: 0.7, exposure: 0.6, motion: 0.3 };
      },
      async extractKeyframes(_ffmpeg, _src, times, outDir) {
        mkdirSync(outDir, { recursive: true });
        return times.map((atSeconds, i) => {
          const p = path.join(outDir, `f_${i}.jpg`);
          writeFileSync(p, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
          return { atSeconds, path: p, bytes: 4 };
        });
      },
      async hasAudibleSpeech() {
        return true;
      },
      async extractAudio(_ffmpeg, _src, outPath) {
        writeFileSync(outPath, Buffer.from([0, 1, 2, 3]));
        return { path: outPath, bytes: 4, seconds: 30 };
      },
    },
  };
}

function freshTmp() {
  return mkdtempSync(path.join(os.tmpdir(), 'reelio-test-'));
}
function subdirs(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith('reelio-an-')) : [];
}

function makeMedia({ objects, spy, calls, tmpDir, maxBytes, timeoutMs, logger } = {}) {
  const fa = fakeAnalysis(calls ?? {});
  return createGcsMedia({
    storage: fakeStorage(objects ?? { [OBJECT]: { bytes: Buffer.from('hello-video-bytes') } }, spy ?? {}),
    bucket: 'reelio-v2-beta-gemini-503615',
    tmpDir: tmpDir ?? freshTmp(),
    maxBytes,
    timeoutMs,
    logger,
    analysis: fa.analysis,
  });
}

const asset = { id: 'asset_a', type: 'video', objectPath: OBJECT };
const ctx = { uid: UID, projectId: PROJECT };

// ── чтение корректного объекта + пайплайн + contentHash ──────────────────────

test('measure: читает корректный объект и вызывает существующий ffprobe/analysis pipeline', async () => {
  const calls = {};
  const bytes = Buffer.from('hello-video-bytes');
  const media = makeMedia({ objects: { [OBJECT]: { bytes } }, calls });

  const measured = await media.measure(asset, ctx);
  assert.equal(measured.contentHash, createHash('sha256').update(bytes).digest('hex'), 'sha256 содержимого');
  assert.equal(measured.durationSeconds, 10);
  assert.equal(measured.width, 1080);
  assert.equal(measured.hasAudio, true);
  assert.ok(Array.isArray(measured.scenes) && measured.scenes.length >= 1);
  assert.ok(calls.probe?.length === 1, 'probeAsset вызван');
  assert.ok(calls.scenes?.length === 1, 'detectSceneCuts вызван');

  const sample = await media.sample(asset, measured, ctx);
  assert.ok(sample.frames.length >= 1, 'кадры извлечены через pipeline');
  assert.equal(sample.frames[0].mimeType, 'image/jpeg');
  assert.ok(sample.audio && sample.audio.mimeType === 'audio/mp4');
  assert.equal(sample.audioSeconds, 30);
  await media.release(measured);
});

test('адаптер работает ТОЛЬКО с настроенным бакетом (bucket из запроса не принимается)', async () => {
  const spy = {};
  const media = makeMedia({ objects: { [OBJECT]: { bytes: Buffer.from('x') } }, spy });
  const measured = await media.measure(asset, ctx);
  await media.sample(asset, measured, ctx);
  await media.release(measured);
  assert.ok(spy.buckets.every((b) => b === 'reelio-v2-beta-gemini-503615'), 'только настроенный бакет');
});

// ── изоляция: чужой uid/project отклоняется ДО скачивания ─────────────────────

test('чужой uid/project отклоняется ДО обращения к GCS', async () => {
  const spy = {};
  const media = makeMedia({ objects: { [OBJECT]: { bytes: Buffer.from('x') } }, spy });
  // объект чужого пользователя
  const foreign = { id: 'a', type: 'video', objectPath: `users/attacker/projects/${PROJECT}/sources/a.mp4` };
  await assert.rejects(media.measure(foreign, ctx), (e) => e.code === 'FORBIDDEN');
  // до GCS дело не дошло: ни одного чтения
  assert.equal(spy.reads.length, 0, 'скачивания не было');
});

test('путь с обходом (../) и абсолютный путь отклоняются', async () => {
  const media = makeMedia({});
  await assert.rejects(
    media.measure({ id: 'a', type: 'video', objectPath: `users/${UID}/projects/${PROJECT}/../x.mp4` }, ctx),
    (e) => e.code === 'INVALID_OBJECT_PATH' || e.code === 'FORBIDDEN',
  );
});

// ── несуществующий объект ────────────────────────────────────────────────────

test('несуществующий объект → ASSET_MISSING', async () => {
  const media = makeMedia({ objects: {} }); // пусто
  await assert.rejects(media.measure(asset, ctx), (e) => e.code === 'ASSET_MISSING');
});

// ── размер по metadata ───────────────────────────────────────────────────────

test('превышение размера по metadata → ASSET_TOO_LARGE, без скачивания', async () => {
  const spy = {};
  const media = makeMedia({
    objects: { [OBJECT]: { bytes: Buffer.from('x'), metaSize: 999999999 } },
    spy,
    maxBytes: 1000,
  });
  await assert.rejects(media.measure(asset, ctx), (e) => e.code === 'ASSET_TOO_LARGE');
  assert.equal(spy.reads.length, 0, 'скачивание не начиналось');
});

// ── реальный поток превышает при ложной metadata ─────────────────────────────

test('реальный поток превышает лимит при ложной metadata → ASSET_TOO_LARGE', async () => {
  const tmp = freshTmp();
  const media = makeMedia({
    objects: { [OBJECT]: { bytes: Buffer.alloc(5000, 7), metaSize: 10 } }, // metadata врёт: 10 байт
    tmpDir: tmp,
    maxBytes: 1000, // а по факту 5000 > 1000
  });
  await assert.rejects(media.measure(asset, ctx), (e) => e.code === 'ASSET_TOO_LARGE');
  assert.equal(subdirs(tmp).length, 0, 'временный каталог убран после обрыва');
});

// ── generation mismatch ──────────────────────────────────────────────────────

test('подмена объекта между metadata и чтением (generation) → ASSET_CHANGED', async () => {
  const tmp = freshTmp();
  // metadata сообщит generation '1', но поток отдаёт объект с generation '2' →
  // pinned чтение generation '1' вернёт 404.
  const media = makeMedia({
    objects: { [OBJECT]: { bytes: Buffer.from('x'), generation: '2' } },
    tmpDir: tmp,
  });
  // getMetadata вернёт generation '2'; чтение пойдёт по '2' — совпадёт. Чтобы
  // сымитировать mismatch, форсируем: metadata='1', реальная generation='2'.
  const media2 = createGcsMedia({
    storage: (() => {
      const objects = { [OBJECT]: { bytes: Buffer.from('x'), generation: '2' } };
      return {
        bucket: () => ({
          file: (p, opts = {}) => ({
            async getMetadata() {
              return [{ size: '1', contentType: 'video/mp4', generation: '1' }]; // говорит '1'
            },
            createReadStream() {
              const r = new Readable({ read() {} });
              queueMicrotask(() => {
                if (opts.generation && String(opts.generation) !== '2') {
                  const e = new Error('gone');
                  e.code = 404;
                  r.destroy(e);
                } else {
                  r.push(objects[p].bytes);
                  r.push(null);
                }
              });
              return r;
            },
          }),
        }),
      };
    })(),
    bucket: 'reelio-v2-beta-gemini-503615',
    tmpDir: tmp,
    analysis: fakeAnalysis().analysis,
  });
  await assert.rejects(media2.measure(asset, ctx), (e) => e.code === 'ASSET_CHANGED');
  assert.equal(subdirs(tmp).length, 0, 'очистка после ASSET_CHANGED');
});

// ── content-type ─────────────────────────────────────────────────────────────

test('недопустимый Content-Type → UNSUPPORTED_MEDIA_TYPE, без скачивания', async () => {
  const spy = {};
  const media = makeMedia({
    objects: { [OBJECT]: { bytes: Buffer.from('x'), contentType: 'application/zip' } },
    spy,
  });
  await assert.rejects(media.measure(asset, ctx), (e) => e.code === 'UNSUPPORTED_MEDIA_TYPE');
  assert.equal(spy.reads.length, 0);
});

// ── очистка: успех, ошибка ffprobe, cancel, timeout ─────────────────────────

test('очистка: после успеха+release временный каталог удалён', async () => {
  const tmp = freshTmp();
  const media = makeMedia({ objects: { [OBJECT]: { bytes: Buffer.from('vid') } }, tmpDir: tmp });
  const measured = await media.measure(asset, ctx);
  assert.equal(subdirs(tmp).length, 1, 'после measure есть один temp каталог');
  await media.sample(asset, measured, ctx);
  await media.release(measured);
  assert.equal(subdirs(tmp).length, 0, 'после release каталог удалён');
});

test('очистка: ошибка ffprobe убирает временный каталог (measure сам чистит)', async () => {
  const tmp = freshTmp();
  const media = createGcsMedia({
    storage: fakeStorage({ [OBJECT]: { bytes: Buffer.from('vid') } }),
    bucket: 'reelio-v2-beta-gemini-503615',
    tmpDir: tmp,
    analysis: { ...fakeAnalysis().analysis, probeAsset: async () => null }, // ffprobe провал
  });
  await assert.rejects(media.measure(asset, ctx), (e) => e.code === 'MEDIA_PROBE_FAILED');
  assert.equal(subdirs(tmp).length, 0, 'каталог убран при ошибке ffprobe');
});

test('очистка: ошибка sample + release убирает каталог', async () => {
  const tmp = freshTmp();
  const media = createGcsMedia({
    storage: fakeStorage({ [OBJECT]: { bytes: Buffer.from('vid') } }),
    bucket: 'reelio-v2-beta-gemini-503615',
    tmpDir: tmp,
    analysis: {
      ...fakeAnalysis().analysis,
      extractKeyframes: async () => {
        throw new Error('ffmpeg boom');
      },
    },
  });
  const measured = await media.measure(asset, ctx);
  await assert.rejects(media.sample(asset, measured, ctx), /ffmpeg boom/);
  assert.equal(subdirs(tmp).length, 1, 'до release каталог ещё есть');
  await media.release(measured);
  assert.equal(subdirs(tmp).length, 0, 'release убрал каталог');
});

test('отмена (AbortSignal) прерывает скачивание и чистит каталог', async () => {
  const tmp = freshTmp();
  const media = makeMedia({ objects: { [OBJECT]: { bytes: Buffer.from('x'), hang: true } }, tmpDir: tmp });
  const ac = new AbortController();
  const p = media.measure(asset, { ...ctx, signal: ac.signal });
  queueMicrotask(() => ac.abort());
  await assert.rejects(p, (e) => e.code === 'CANCELLED');
  assert.equal(subdirs(tmp).length, 0, 'очистка после отмены');
});

test('таймаут скачивания → TIMEOUT и очистка', async () => {
  const tmp = freshTmp();
  const media = makeMedia({
    objects: { [OBJECT]: { bytes: Buffer.from('x'), hang: true } },
    tmpDir: tmp,
    timeoutMs: 30,
  });
  await assert.rejects(media.measure(asset, ctx), (e) => e.code === 'TIMEOUT');
  assert.equal(subdirs(tmp).length, 0, 'очистка после таймаута');
});

test('AbortSignal прокидывается в ffmpeg/ffprobe хелперы', async () => {
  const calls = {};
  const media = makeMedia({ objects: { [OBJECT]: { bytes: Buffer.from('x') } }, calls });
  const ac = new AbortController();
  const measured = await media.measure(asset, { ...ctx, signal: ac.signal });
  assert.equal(calls.probe[0].signal, ac.signal, 'signal передан в probeAsset');
  assert.equal(calls.scenes[0].signal, ac.signal, 'signal передан в detectSceneCuts');
  await media.release(measured);
});

// ── пользовательское имя файла не попадает в локальный путь ──────────────────

test('локальный путь использует случайное имя, НЕ имя пользователя', async () => {
  const tmp = freshTmp();
  const evil = { id: 'a', type: 'video', objectPath: `users/${UID}/projects/${PROJECT}/sources/EVILNAME.mp4` };
  // подменяем extractKeyframes/probe, но нам важен srcPath из probe.
  const calls = {};
  const media = makeMedia({ objects: { [`users/${UID}/projects/${PROJECT}/sources/EVILNAME.mp4`]: { bytes: Buffer.from('x') } }, calls, tmpDir: tmp });
  const measured = await media.measure(evil, ctx);
  const src = calls.probe[0].srcPath;
  assert.match(path.basename(src), /^source_[0-9a-f]+\.bin$/, 'случайное имя');
  assert.ok(!src.includes('EVILNAME'), 'имя пользователя НЕ в пути');
  await media.release(measured);
});

// ── wiring: createMediaForMode / assertMediaForMode ──────────────────────────

test('createMediaForMode: cloud строит adapter, local — null', async () => {
  const cloud = await createMediaForMode(
    { mode: 'cloud', storage: { bucket: 'reelio-v2-beta-gemini-503615' }, firebase: { projectId: 'p' } },
    { storage: fakeStorage({}) },
  );
  assert.equal(typeof cloud.measure, 'function');
  assert.equal(typeof cloud.sample, 'function');
  assert.equal(typeof cloud.release, 'function');

  const local = await createMediaForMode({ mode: 'local', storage: {}, firebase: {} });
  assert.equal(local, null);
});

test('createMediaForMode: cloud без бакета — отказ старта (fail-closed)', async () => {
  await assert.rejects(
    createMediaForMode({ mode: 'cloud', storage: { bucket: '' }, firebase: { projectId: 'p' } }, {
      storage: fakeStorage({}),
    }),
    /REFUSING TO START/,
  );
});

test('assertMediaForMode: cloud без media бросает, с media — ок; local — ок', () => {
  assert.throws(() => assertMediaForMode({ mode: 'cloud' }, null), /REFUSING TO START/);
  assert.throws(() => assertMediaForMode({ mode: 'cloud' }, undefined), /REFUSING TO START/);
  assert.doesNotThrow(() => assertMediaForMode({ mode: 'cloud' }, { measure() {} }));
  assert.doesNotThrow(() => assertMediaForMode({ mode: 'local' }, null));
});

// ── wiring: cloud createApp РЕАЛЬНО строит и передаёт media в AnalysisService ──

function cloudEnv(overrides = {}) {
  return {
    REELIO_RUNTIME: 'cloud',
    FIREBASE_PROJECT_ID: 'proj-test',
    REELIO_STORE: 'memory', // не важно: store передаём override'ом
    CLOUD_TASKS_QUEUE: 'reelio-analysis-v2',
    CLOUD_TASKS_LOCATION: 'europe-west1',
    INTERNAL_BASE_URL: 'https://reelio-backend-beta-abc123-ew.a.run.app',
    TASKS_INVOKER_SA: 'reelio-tasks@proj-test.iam.gserviceaccount.com',
    REELIO_RENDER_BUCKET: 'reelio-v2-beta-gemini-503615',
    ...overrides,
  };
}

test('cloud createApp строит настоящий GCS media adapter и передаёт его в AnalysisService', async () => {
  const config = loadConfig(cloudEnv());
  const built = await createApp({
    config,
    store: { kind: 'firestore' }, // проходит assertStoreForMode, не используется
    verifier: fakeVerifier(),
    gemini: fakeGemini(),
    render: { signer: {}, jobs: {} },
    oidcVerifier: { async verify() {} },
    taskQueue: { setHandler() {}, enqueue: async () => ({ scheduled: true }) },
    watchdogQueue: null,
    storage: fakeStorage({}), // тестовый seam вместо реального @google-cloud/storage
  });

  // Настоящий AnalysisService получил настоящий media adapter (не undefined).
  assert.ok(built.service, 'service построен');
  assert.equal(typeof built.service.media.measure, 'function');
  assert.equal(typeof built.service.media.sample, 'function');
  assert.equal(typeof built.service.media.release, 'function', 'release есть → это GCS adapter, не заглушка');
});

test('cloud createApp падает на старте, если бакет для media не задан (fail-closed)', async () => {
  const config = loadConfig(cloudEnv({ REELIO_RENDER_BUCKET: '', BETA_MEDIA_BUCKET: '' }));
  await assert.rejects(
    createApp({
      config,
      store: { kind: 'firestore' },
      verifier: fakeVerifier(),
      gemini: fakeGemini(),
      render: { signer: {}, jobs: {} },
      oidcVerifier: { async verify() {} },
      taskQueue: { setHandler() {}, enqueue: async () => ({ scheduled: true }) },
      watchdogQueue: null,
      storage: fakeStorage({}),
    }),
    /REFUSING TO START/,
  );
});
