// Cloud media adapter: скачивание материала из GCS + локальный анализ (§ фикс
// «media=undefined в cloud»).
//
// Раньше в cloud mode AnalysisService получал media=undefined и падал на
// probing ещё до Gemini. Здесь — настоящий адаптер: он безопасно скачивает ОДИН
// материал из НАСТРОЕННОГО бакета по server-validated objectPath во временный
// файл (потоком, с жёстким лимитом байтов, отменой и таймаутом), затем вызывает
// существующие функции local-analysis.js (ffprobe, сцены, качество, кадры,
// аудио). Временный каталог удаляется в release(), в любом исходе.
//
// Интерфейс совместим с fakeMedia тестов: measure(asset,{signal,uid,projectId}),
// sample(asset,measured,{signal,uid,projectId}); плюс release(measured) для
// гарантированной очистки скачанного файла (runJob зовёт его в finally).

import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { assertOwnedPath } from './auth.js';
import { ApiError } from './errors.js';
import { ALLOWED_CONTENT_TYPES, ANALYSIS_LIMITS } from './limits.js';
import {
  cutsToScenes,
  detectSceneCuts,
  extractAudio,
  extractKeyframes,
  frameToInlineData,
  hasAudibleSpeech,
  measureQuality,
  probeAsset,
  selectKeyframeTimes,
} from './local-analysis.js';

/** Скачивает pinned-generation объект в файл потоком: лимит байтов, отмена, таймаут, sha256. */
async function downloadPinned({ file, destPath, maxBytes, signal, timeoutMs }) {
  const ac = new AbortController();
  const onParentAbort = () => ac.abort(new ApiError('CANCELLED', 'Анализ отменён.'));
  if (signal) {
    if (signal.aborted) ac.abort(new ApiError('CANCELLED', 'Анализ отменён.'));
    else signal.addEventListener('abort', onParentAbort, { once: true });
  }
  const timer = setTimeout(
    () => ac.abort(new ApiError('TIMEOUT', 'Скачивание материала прервано по таймауту.')),
    timeoutMs,
  );

  const hash = createHash('sha256');
  let bytes = 0;
  // Жёсткий лимит по ФАКТУ переданных байтов — даже если metadata врёт.
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        cb(new ApiError('ASSET_TOO_LARGE', 'Материал превышает допустимый размер.'));
        return;
      }
      hash.update(chunk);
      cb(null, chunk);
    },
  });

  try {
    await pipeline(file.createReadStream(), counter, createWriteStream(destPath), { signal: ac.signal });
    return { contentHash: hash.digest('hex'), bytes };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const reason = ac.signal.reason;
    if (reason instanceof ApiError) throw reason; // таймаут/отмена с точным кодом
    if (signal?.aborted) throw new ApiError('CANCELLED', 'Анализ отменён.');
    // Pinned generation исчез между metadata и чтением → объект подменён.
    if (err?.code === 404 || err?.code === 'ENOENT') {
      throw new ApiError('ASSET_CHANGED', 'Материал изменился во время анализа.');
    }
    // Деталь безопасна: только код/имя, без пути/uid.
    throw new ApiError('INTERNAL', 'Не удалось скачать материал.', {
      detail: `gcs stream: ${err?.code ?? err?.name ?? 'error'}`,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onParentAbort);
  }
}

function mapMetadataError(err) {
  if (err?.code === 404) return new ApiError('ASSET_MISSING', 'Материал не найден.');
  return new ApiError('INTERNAL', 'Не удалось получить сведения о материале.', {
    detail: `gcs metadata: ${err?.code ?? err?.name ?? 'error'}`,
  });
}

/**
 * Фабрика cloud media adapter.
 *
 * @param {{storage:object, bucket:string, ffmpegPath?:string, ffprobePath?:string,
 *          logger?:object}} deps
 */
export function createGcsMedia(deps) {
  const { storage, bucket } = deps;
  if (!storage || !bucket) {
    throw new Error('createGcsMedia требует storage и bucket.');
  }
  const ffmpegPath = deps.ffmpegPath || 'ffmpeg';
  const ffprobePath = deps.ffprobePath || 'ffprobe';
  const logger = deps.logger ?? null;
  const maxBytes = deps.maxBytes ?? ANALYSIS_LIMITS.maxSourceBytes;
  const timeoutMs = deps.timeoutMs ?? ANALYSIS_LIMITS.perAssetTimeoutMs;
  const tmpRoot = deps.tmpDir || os.tmpdir();
  // Функции локального анализа — по умолчанию НАСТОЯЩИЕ из local-analysis.js (не
  // дублируем FFmpeg-логику). В тестах подменяются, чтобы проверять логику
  // адаптера (скачивание/валидация/очистка) без реального ffmpeg.
  const A = {
    probeAsset,
    detectSceneCuts,
    cutsToScenes,
    measureQuality,
    selectKeyframeTimes,
    extractKeyframes,
    frameToInlineData,
    hasAudibleSpeech,
    extractAudio,
    ...deps.analysis,
  };

  // handle → { dir, srcPath, generation }. Живёт от measure до release (в рамках
  // одного runJob-исполнения на одном инстансе).
  const open = new Map();

  /** Проверка владения + metadata (существование, размер, тип, generation) ДО скачивания. */
  async function validateAndMeta(asset, { uid, projectId }) {
    // Повторная проверка ownership: путь обязан лежать внутри users/{uid}/projects/{projectId}/.
    const objectPath = assertOwnedPath(asset.objectPath, uid, projectId);
    const type = asset.type === 'photo' ? 'photo' : 'video';
    const file = storage.bucket(bucket).file(objectPath);

    let md;
    try {
      [md] = await file.getMetadata();
    } catch (err) {
      throw mapMetadataError(err);
    }
    const size = Number(md?.size) || 0;
    if (size <= 0) throw new ApiError('ASSET_MISSING', 'Материал недоступен.');
    if (size > maxBytes) throw new ApiError('ASSET_TOO_LARGE', 'Материал превышает допустимый размер.');
    const contentType = String(md?.contentType || 'application/octet-stream').toLowerCase();
    if (!ALLOWED_CONTENT_TYPES[type]?.has(contentType)) {
      throw new ApiError('UNSUPPORTED_MEDIA_TYPE', 'Формат материала не поддерживается.');
    }
    const generation = md?.generation;
    if (!generation) throw new ApiError('ASSET_MISSING', 'Материал недоступен.');
    return { objectPath, type, generation };
  }

  return {
    async measure(asset, { signal, uid, projectId } = {}) {
      const { objectPath, generation } = await validateAndMeta(asset, { uid, projectId });

      // Уникальный временный каталог + случайное имя файла (НЕ имя пользователя).
      const dir = await mkdtemp(path.join(tmpRoot, 'reelio-an-'));
      const srcPath = path.join(dir, `source_${randomBytes(8).toString('hex')}.bin`);
      try {
        // Скачиваем ИМЕННО ту generation, что видели в metadata (pin).
        const pinned = storage.bucket(bucket).file(objectPath, { generation });
        const { contentHash } = await downloadPinned({
          file: pinned,
          destPath: srcPath,
          maxBytes,
          signal,
          timeoutMs,
        });

        const probe = await A.probeAsset(ffprobePath, srcPath, { signal });
        if (!probe || !(probe.durationSeconds > 0)) {
          throw new ApiError('MEDIA_PROBE_FAILED', 'Не удалось разобрать материал.');
        }
        const scenes = A.cutsToScenes(
          await A.detectSceneCuts(ffmpegPath, srcPath, { signal }),
          probe.durationSeconds,
        );
        const quality = (await A.measureQuality(ffmpegPath, srcPath, { signal })) ?? {};

        const handle = randomBytes(12).toString('hex');
        open.set(handle, { dir, srcPath, generation });
        return {
          contentHash,
          durationSeconds: probe.durationSeconds,
          width: probe.width,
          height: probe.height,
          rotation: probe.rotation,
          fps: probe.fps,
          hasAudio: probe.hasAudio,
          scenes,
          quality,
          generation,
          _handle: handle,
        };
      } catch (err) {
        // Сбой measure: чистим СВОЙ временный каталог здесь и не стошим handle.
        await safeRmDir(dir, logger);
        throw err;
      }
    },

    async sample(asset, measured, { signal, uid, projectId } = {}) {
      // Defense-in-depth: та же проверка владения перед доступом к файлу.
      assertOwnedPath(asset.objectPath, uid, projectId);
      const st = open.get(measured?._handle);
      if (!st) {
        // fail-closed: без скачанного файла ничего не делаем (не перекачиваем вслепую).
        throw new ApiError('INTERNAL', 'Внутреннее состояние анализа утеряно.', {
          detail: 'media handle missing',
        });
      }
      const { dir, srcPath } = st;

      const times = A.selectKeyframeTimes({
        scenes: measured.scenes,
        durationSeconds: measured.durationSeconds,
      });
      const framesDir = path.join(dir, 'frames');
      const frameFiles = await A.extractKeyframes(ffmpegPath, srcPath, times, framesDir, { signal });
      const frames = [];
      for (const frame of frameFiles) {
        frames.push(await A.frameToInlineData(frame.path));
      }

      let audio = null;
      let audioSeconds = 0;
      if (measured.hasAudio) {
        const audible = await A.hasAudibleSpeech(ffmpegPath, srcPath, { signal });
        if (audible) {
          const extracted = await A.extractAudio(ffmpegPath, srcPath, path.join(dir, 'audio.m4a'), {
            signal,
          });
          if (extracted) {
            const buf = await readFile(extracted.path);
            audio = { mimeType: 'audio/mp4', data: buf.toString('base64') };
            audioSeconds = extracted.seconds;
          }
        }
      }
      return { frames, audio, audioSeconds };
    },

    /**
     * Освобождает временный каталог, созданный measure(). Зовётся runJob в
     * finally после каждого материала — при успехе, ошибке ffprobe, отмене,
     * таймауте и обрыве. Удаляет ТОЛЬКО точный каталог этого материала.
     */
    async release(measured) {
      const handle = measured?._handle;
      if (!handle) return;
      const st = open.get(handle);
      if (!st) return;
      open.delete(handle);
      await safeRmDir(st.dir, logger);
    },
  };
}

/** Удаляет ровно указанный каталог; ошибку очистки логирует безопасно, не пробрасывает. */
async function safeRmDir(dir, logger) {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (err) {
    // Ошибка очистки НЕ должна маскировать основную — только безопасный лог.
    logger?.warn?.('media temp cleanup failed', { stage: 'cleanup', code: err?.code ?? 'unknown' });
  }
}

/**
 * Фабрика media по режиму. В cloud — обязателен GCS adapter на НАСТРОЕННОМ
 * бакете (fail-closed: нет бакета → отказ старта). В local/test — null: media
 * приходит из overrides (fakeMedia) или отсутствует, поведение как было.
 */
export async function createMediaForMode(config, overrides = {}) {
  if (config.mode !== 'cloud') return null;
  const bucket = config.storage?.bucket;
  if (!bucket) {
    throw new Error(
      'REFUSING TO START (media): в cloud mode обязателен бакет (REELIO_RENDER_BUCKET/BETA_MEDIA_BUCKET).',
    );
  }
  let storage = overrides.storage;
  if (!storage) {
    const { Storage } = await import('@google-cloud/storage');
    storage = new Storage({ projectId: config.firebase.projectId });
  }
  return createGcsMedia({
    storage,
    bucket,
    ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
    ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',
    logger: overrides.logger ?? null,
  });
}

/** Startup-инвариант: в cloud mode media ОБЯЗАН быть (не undefined/заглушка отсутствия). */
export function assertMediaForMode(config, media) {
  if (config.mode === 'cloud' && !media) {
    throw new Error('REFUSING TO START (media): cloud media adapter обязателен, получен пустой.');
  }
}
