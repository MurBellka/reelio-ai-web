// Пайплайн рендера: plan.json → MP4 в бакете.
//
// Фазы и их вклад в progress заданы §4.2 контракта; здесь они выдерживаются
// один в один, чтобы полоса в UI шла ровно:
//
//   preparing  0.05–0.10  разбор и проверка плана
//   downloading 0.10–0.30 загрузка исходников + ffprobe каждого
//   rendering  0.30–0.60  субтитры, музыка, построение filter_complex
//   encoding   0.60–0.90  один проход FFmpeg (фильтрация и кодирование)
//   uploading  0.90–0.98  проверка результата, обложка, выгрузка
//   finalizing 0.98–1.00  лог, очистка tmp
//
// Отмена (§8.1) кооперативная: между шагами и во время FFmpeg проверяется
// cancelRequested из ответов backend'а.

import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { RESOLUTIONS, logPath, outputVideoPath, thumbnailPath, tmpPrefix } from './contract.js';
import { CancelledError, WorkerError } from './errors.js';
import {
  assertCapabilities,
  detectCapabilities,
  hasFastStart,
  runFfmpeg,
} from './ffmpeg.js';
import { buildRenderCommand, buildThumbnailCommand } from './filtergraph.js';
import { resolveMusicInput } from './music.js';
import { parseRenderPlan } from './plan.js';
import { analyzeAsset, verifyOutput } from './probe.js';
import { buildCues, toAss, toSrt } from './subtitles.js';
import { buildTimeline } from './timeline.js';

/** Расширение по объектному пути исходника — FFmpeg ориентируется на него. */
function extensionOf(objectPath) {
  const ext = path.extname(objectPath);
  return /^\.[A-Za-z0-9]{1,5}$/.test(ext) ? ext.toLowerCase() : '.bin';
}

/**
 * Один прогон рендера.
 *
 * @param {{env: object, storage: object, reporter: object, logger: object}} deps
 * @returns {Promise<{status: 'succeeded'|'cancelled', result?: object}>}
 */
export async function runRender({ env, storage, reporter, logger }) {
  const workDir = env.workDir || path.join(os.tmpdir(), `reelio-${env.jobId}`);
  const sourcesDir = path.join(workDir, 'sources');
  const outDir = path.join(workDir, 'out');

  try {
    return await renderInside({ env, storage, reporter, logger, workDir, sourcesDir, outDir });
  } finally {
    // Временные файлы удаляются всегда: и после успеха, и после ошибки, и
    // после отмены (§8.1 требует убрать tmp/ при отмене).
    if (env.keepTmp) {
      logger.warn('tmp kept by REELIO_KEEP_TMP', { workDir });
    } else {
      await rm(workDir, { recursive: true, force: true }).catch((err) =>
        logger.warn('tmp cleanup failed', { reason: err?.code || 'error' }),
      );
    }
    // Мусор в бакете от предыдущих попыток — best effort, ошибки не важны.
    await storage
      .removePrefix(tmpPrefix(env.jobPrefix))
      .catch(() => logger.warn('bucket tmp cleanup skipped'));
  }
}

async function renderInside({ env, storage, reporter, logger, workDir, sourcesDir, outDir }) {
  // ── preparing ───────────────────────────────────────────────────────────
  await reporter.report('preparing', 0, 'Проверка монтажного плана');
  reporter.throwIfCancelled();

  await mkdir(sourcesDir, { recursive: true });
  await mkdir(outDir, { recursive: true });

  const document = await storage.readJson(env.planObjectPath);
  const plan = parseRenderPlan(document, {
    jobId: env.jobId,
    projectId: env.projectId,
    contractVersion: env.contractVersion,
  });

  const capabilities = await detectCapabilities(env.ffmpegPath);
  assertCapabilities(capabilities);
  logger.info('ffmpeg capabilities', {
    version: capabilities.version,
    subtitles: capabilities.subtitles,
    zoompan: capabilities.zoompan,
    loudnorm: capabilities.loudnorm,
    sidechaincompress: capabilities.sidechaincompress,
  });

  const timeline = buildTimeline(plan.clips);
  logger.info('plan accepted', {
    planId: plan.planId,
    clips: plan.clips.length,
    assets: plan.assets.length,
    resolution: plan.export.resolution,
    fps: plan.export.fps,
    plannedDuration: plan.totalDuration,
    timelineDuration: timeline.totalDuration,
  });

  await reporter.report('preparing', 1, 'План принят');

  // ── downloading ─────────────────────────────────────────────────────────
  await reporter.report('downloading', 0, 'Загрузка исходников');

  // Ducking нужен, только если музыка вообще играет (§2), — иначе не тратим
  // время на анализ громкости каждого материала.
  const musicEnabled = plan.music.track !== 'none';
  const sources = new Map();

  for (const [i, asset] of plan.assets.entries()) {
    reporter.throwIfCancelled();

    const localPath = path.join(sourcesDir, `${asset.id}${extensionOf(asset.objectPath)}`);
    const downloaded = await storage.download(asset.objectPath, localPath);

    // Первый клип этого материала задаёт отрезок для анализа громкости.
    const clip = plan.clips.find((c) => c.mediaId === asset.id);
    const probe = await analyzeAsset({
      ffmpegPath: env.ffmpegPath,
      ffprobePath: env.ffprobePath,
      filePath: localPath,
      asset,
      needsAudioAnalysis: musicEnabled && asset.type === 'video',
      segment: clip && clip.type === 'video' ? { start: clip.start ?? 0, duration: clip.duration } : undefined,
    });

    sources.set(asset.id, { ...probe, sizeBytes: downloaded.sizeBytes });
    logger.info('source ready', {
      assetId: asset.id,
      sizeBytes: downloaded.sizeBytes,
      frame: `${probe.width}x${probe.height}`,
      rotation: probe.rotation,
      hasAudio: probe.hasAudio,
      hasSpeech: probe.hasSpeech,
    });

    await reporter.report('downloading', (i + 1) / plan.assets.length, 'Загрузка исходников');
  }

  // ── rendering ───────────────────────────────────────────────────────────
  await reporter.report('rendering', 0, 'Подготовка монтажа');
  reporter.throwIfCancelled();

  const hasSpeech = [...sources.values()].some((s) => s.hasSpeech);

  const cues = buildCues({ captions: plan.captions, segments: timeline.segments });
  let subtitlePath = null;
  let srtText = null;
  if (cues.length > 0) {
    srtText = toSrt(cues);
    subtitlePath = path.join(workDir, 'captions.ass');
    await writeFile(
      subtitlePath,
      toAss(cues, {
        style: plan.captions.style,
        colorHex: plan.captions.colorHex,
        width: plan.export.width,
        height: plan.export.height,
        fontName: env.fontName,
      }),
      'utf8',
    );
  }
  await reporter.report('rendering', 0.4, 'Субтитры готовы');

  const musicInput = await resolveMusicInput({
    track: plan.music.track,
    musicDir: env.musicDir,
    duration: timeline.totalDuration,
  });
  if (musicInput) {
    logger.info('music resolved', { kind: musicInput.kind, track: musicInput.label });
  }

  const videoPath = path.join(outDir, `reel_${plan.export.height}p.mp4`);
  const command = buildRenderCommand({
    plan,
    timeline,
    sources,
    fitMode: env.fitMode,
    capabilities,
    subtitlePath,
    fontsDir: env.fontsDir,
    musicInput,
    hasSpeech,
    outputPath: videoPath,
    preset: env.preset,
  });

  for (const note of command.notes) logger.warn('pipeline degraded', { note });
  logger.debug('filter graph built', {
    nodes: command.filterComplex.split(';').length,
    expectedDuration: command.expectedDuration,
  });

  await reporter.report('rendering', 1, 'Монтаж собран');

  // ── encoding ────────────────────────────────────────────────────────────
  const resolutionLabel = RESOLUTIONS[plan.export.resolution]?.label ?? `${plan.export.height}p`;
  await reporter.report('encoding', 0, `Кодирование ${resolutionLabel}`);

  const controller = new AbortController();
  let lastReported = 0;

  const encodeResult = await runFfmpeg(env.ffmpegPath, command.args, {
    signal: controller.signal,
    logger,
    onProgress: (sample) => {
      if (sample.seconds === null || command.expectedDuration <= 0) return;
      const fraction = Math.min(1, sample.seconds / command.expectedDuration);
      // Не чаще ~одного отчёта на 2% прогресса: канал §8.1 не для спама.
      if (fraction - lastReported < 0.02 && !sample.done) return;
      lastReported = fraction;

      reporter
        .report('encoding', fraction, 'Кодирование видео')
        .then(() => {
          if (reporter.cancelRequested || reporter.terminated) controller.abort();
        })
        .catch(() => controller.abort());
    },
  });

  if (encodeResult.aborted) {
    throw new CancelledError();
  }
  reporter.throwIfCancelled();

  // ── uploading ───────────────────────────────────────────────────────────
  await reporter.report('uploading', 0, 'Проверка результата');

  const verification = await verifyOutput(env.ffprobePath, videoPath, {
    width: plan.export.width,
    height: plan.export.height,
    fps: plan.export.fps,
    durationSeconds: command.expectedDuration,
  });
  if (!verification.ok) {
    throw new WorkerError('WORKER_FAILED', 'Готовый ролик не прошёл проверку.', {
      detail: `ffprobe verification failed: ${verification.problems.join('; ')}`,
    });
  }
  if (!(await hasFastStart(videoPath))) {
    throw new WorkerError('WORKER_FAILED', 'Готовый ролик не прошёл проверку.', {
      detail: 'moov atom is not at the beginning (faststart missing)',
    });
  }
  logger.info('output verified', verification.info);

  // Обложка — кадр из клипа, помеченного как coverClipId (§2).
  const coverSegment =
    timeline.segments.find((s) => s.id === plan.coverClipId) ?? timeline.segments[0];
  const coverAt = Math.min(
    command.expectedDuration - 0.05,
    coverSegment.start + Math.min(0.5, coverSegment.clip.duration / 2),
  );
  const thumbPath = path.join(outDir, 'thumbnail.jpg');
  await runFfmpeg(
    env.ffmpegPath,
    buildThumbnailCommand({ videoPath, atSeconds: coverAt, outputPath: thumbPath }),
    { logger },
  );

  await reporter.report('uploading', 0.3, 'Выгрузка ролика');
  reporter.throwIfCancelled();

  const videoObjectPath = outputVideoPath(env.outputPrefix, plan.export.height);
  const thumbObjectPath = thumbnailPath(env.outputPrefix);
  const objectMetadata = {
    jobId: env.jobId,
    projectId: env.projectId,
    planId: plan.planId,
    contractVersion: String(env.contractVersion),
  };

  const uploaded = await storage.upload(videoPath, videoObjectPath, {
    contentType: 'video/mp4',
    cacheControl: 'private, max-age=0, no-transform',
    metadata: objectMetadata,
  });

  await reporter.report('uploading', 0.8, 'Выгрузка обложки');
  await storage.upload(thumbPath, thumbObjectPath, {
    contentType: 'image/jpeg',
    cacheControl: 'private, max-age=0, no-transform',
    metadata: objectMetadata,
  });

  // Субтитры кладём рядом sidecar-файлом: они полезны и когда вшиты в кадр
  // (соцсети умеют их подхватывать), и обязательны, когда вшить не удалось.
  if (srtText) {
    await storage
      .writeText(`${env.outputPrefix}/captions.srt`, srtText, {
        contentType: 'application/x-subrip; charset=utf-8',
      })
      .catch((err) => logger.warn('captions upload failed', { reason: err?.code || 'error' }));
  }

  // ── finalizing ──────────────────────────────────────────────────────────
  await reporter.report('finalizing', 0, 'Завершение');

  const thumbStat = await stat(thumbPath).catch(() => null);

  /** RenderResult (§4.3). */
  const result = {
    objectPath: videoObjectPath,
    // Signed URL подписывает backend: у SA worker'а нет прав signBlob (§9),
    // и это намеренно — worker ограничен одним бакетом.
    downloadUrl: null,
    downloadUrlExpiresAt: null,
    thumbnailObjectPath: thumbObjectPath,
    thumbnailUrl: null,
    sizeBytes: uploaded.sizeBytes,
    thumbnailSizeBytes: thumbStat?.size ?? null,
    durationSeconds: verification.info.durationSeconds,
    width: plan.export.width,
    height: plan.export.height,
    fps: plan.export.fps,
    videoCodec: 'h264',
    audioCodec: 'aac',
    checksumCrc32c: uploaded.crc32c,
    renderedAt: new Date().toISOString(),
  };

  logger.info('render finished', {
    objectPath: result.objectPath,
    sizeBytes: result.sizeBytes,
    durationSeconds: result.durationSeconds,
  });

  return { status: 'succeeded', result, plan, verification };
}

/** Выгружает worker.log в бакет (§6). Диагностика, клиенту не отдаётся. */
export async function uploadWorkerLog({ env, storage, logger }) {
  if (!env.uploadLog) return;
  try {
    await storage.writeText(logPath(env.jobPrefix), logger.dump(), {
      contentType: 'text/plain; charset=utf-8',
    });
  } catch {
    // Лог — не критичный артефакт: его потеря не должна менять статус задачи.
  }
}
