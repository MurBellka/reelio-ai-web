// ffprobe-валидация исходников: пригодность к рендеру, rotation metadata,
// наличие и громкость звука.
//
// Зачем отдельный проход: план приходит с метаданными от клиента, но доверять
// им нельзя — файл мог быть перезалит, повреждён или снят вертикально «через
// поворот». Всё, от чего зависит кадрирование и звуковой тракт, измеряется по
// самому файлу.

import { runFfmpeg, runFfprobe } from './ffmpeg.js';
import { WorkerError } from './errors.js';

/** Нормализованный угол поворота из display matrix или устаревшего тега. */
export function rotationOf(stream) {
  let rotation = 0;

  for (const side of stream?.side_data_list ?? []) {
    if (side?.rotation !== undefined && Number.isFinite(Number(side.rotation))) {
      rotation = Number(side.rotation);
      break;
    }
  }
  if (rotation === 0 && stream?.tags?.rotate !== undefined) {
    rotation = Number(stream.tags.rotate) || 0;
  }

  // К [0, 360): -90 и 270 — один и тот же поворот.
  return ((Math.round(rotation) % 360) + 360) % 360;
}

/**
 * Размеры кадра ПОСЛЕ применения поворота. Именно они определяют, как кадр
 * ложится в 9:16: у видео с телефона width/height в контейнере часто
 * «горизонтальные», а на экране кадр вертикальный.
 */
export function displayDimensions(stream) {
  const width = Number(stream?.width) || 0;
  const height = Number(stream?.height) || 0;
  const rotation = rotationOf(stream);
  const swapped = rotation === 90 || rotation === 270;
  return {
    rotation,
    width: swapped ? height : width,
    height: swapped ? width : height,
  };
}

/** Кадровая частота из r_frame_rate («30000/1001» → 29.97). */
export function frameRateOf(stream) {
  const raw = stream?.avg_frame_rate || stream?.r_frame_rate || '';
  const [num, den] = String(raw).split('/').map(Number);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  const fps = num / den;
  return fps > 0 ? fps : null;
}

/**
 * Средняя громкость участка в dBFS через `volumedetect`.
 * Возвращает null, если измерить не удалось (это не ошибка рендера).
 */
export async function meanVolumeDb(ffmpegPath, filePath, { start = 0, duration = null } = {}) {
  const args = ['-hide_banner', '-nostdin'];
  if (start > 0) args.push('-ss', String(start));
  args.push('-i', filePath);
  if (duration) args.push('-t', String(duration));
  args.push('-vn', '-af', 'volumedetect', '-f', 'null', '-');

  try {
    const { stderr } = await runFfmpeg(ffmpegPath, args);
    const match = /mean_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(stderr);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Порог «в дорожке есть речь». Тишина в контейнере (дорожка есть, но пустая)
 * даёт около -91 dBFS; реальная речь — заметно громче.
 */
export const SPEECH_MEAN_VOLUME_DB = -50;

/**
 * Полный анализ одного материала.
 *
 * @param {{ffmpegPath: string, ffprobePath: string, filePath: string,
 *          asset: {id: string, type: string}, needsAudioAnalysis?: boolean,
 *          segment?: {start: number, duration: number}}} opts
 */
export async function analyzeAsset(opts) {
  const { ffmpegPath, ffprobePath, filePath, asset, needsAudioAnalysis = false, segment } = opts;

  const probe = await runFfprobe(ffprobePath, filePath);
  const streams = probe.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');

  if (!video) {
    throw new WorkerError('SOURCE_UNREADABLE', 'В материале нет изображения.', {
      detail: `asset ${asset.id}: no video stream`,
    });
  }

  const display = displayDimensions(video);
  if (!display.width || !display.height) {
    throw new WorkerError('SOURCE_UNREADABLE', 'Не удалось определить размер кадра материала.', {
      detail: `asset ${asset.id}: zero dimensions`,
    });
  }

  const containerDuration = Number(probe.format?.duration);
  const streamDuration = Number(video.duration);
  const duration = Number.isFinite(containerDuration)
    ? containerDuration
    : Number.isFinite(streamDuration)
      ? streamDuration
      : null;

  // Фото могут прийти как одиночный кадр видеопотока (jpg/png) — это норма.
  if (asset.type === 'video' && duration !== null && duration <= 0) {
    throw new WorkerError('SOURCE_UNREADABLE', 'Материал не содержит воспроизводимого видео.', {
      detail: `asset ${asset.id}: non-positive duration`,
    });
  }

  let meanVolume = null;
  let hasSpeech = false;
  if (audio && needsAudioAnalysis) {
    meanVolume = await meanVolumeDb(ffmpegPath, filePath, {
      start: segment?.start ?? 0,
      duration: segment?.duration ?? null,
    });
    hasSpeech = meanVolume !== null && meanVolume > SPEECH_MEAN_VOLUME_DB;
  }

  return {
    assetId: asset.id,
    filePath,
    codedWidth: Number(video.width) || 0,
    codedHeight: Number(video.height) || 0,
    rotation: display.rotation,
    width: display.width,
    height: display.height,
    fps: frameRateOf(video),
    videoCodec: video.codec_name ?? null,
    pixelFormat: video.pix_fmt ?? null,
    duration,
    hasAudio: Boolean(audio),
    audioCodec: audio?.codec_name ?? null,
    audioSampleRate: audio ? Number(audio.sample_rate) || null : null,
    audioChannels: audio ? Number(audio.channels) || null : null,
    meanVolumeDb: meanVolume,
    hasSpeech,
  };
}

/**
 * Проверка готового MP4 (§4.3): контейнер, кодеки, кадр, звук и длительность
 * должны совпасть с тем, что обещано в RenderJob.export.
 *
 * @returns {{ok: boolean, problems: string[], info: object}}
 */
export async function verifyOutput(ffprobePath, filePath, expected) {
  const probe = await runFfprobe(ffprobePath, filePath);
  const video = (probe.streams ?? []).find((s) => s.codec_type === 'video');
  const audio = (probe.streams ?? []).find((s) => s.codec_type === 'audio');
  const problems = [];

  if (!video) problems.push('в результате нет видеопотока');
  if (!audio) problems.push('в результате нет аудиопотока');

  if (video) {
    if (video.codec_name !== 'h264') problems.push(`видеокодек ${video.codec_name} вместо h264`);
    if (video.pix_fmt !== 'yuv420p') problems.push(`формат пикселей ${video.pix_fmt} вместо yuv420p`);
    if (Number(video.width) !== expected.width || Number(video.height) !== expected.height) {
      problems.push(`кадр ${video.width}x${video.height} вместо ${expected.width}x${expected.height}`);
    }
    const fps = frameRateOf(video);
    if (fps !== null && Math.abs(fps - expected.fps) > 0.5) {
      problems.push(`частота кадров ${fps.toFixed(2)} вместо ${expected.fps}`);
    }
  }

  if (audio) {
    if (audio.codec_name !== 'aac') problems.push(`аудиокодек ${audio.codec_name} вместо aac`);
    if (Number(audio.sample_rate) !== 48000) {
      problems.push(`частота дискретизации ${audio.sample_rate} вместо 48000`);
    }
    if (Number(audio.channels) !== 2) problems.push(`каналов ${audio.channels} вместо 2`);
  }

  const duration = Number(probe.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    problems.push('не удалось определить длительность результата');
  } else if (
    Number.isFinite(expected.durationSeconds) &&
    Math.abs(duration - expected.durationSeconds) > Math.max(0.75, expected.durationSeconds * 0.05)
  ) {
    problems.push(
      `длительность ${duration.toFixed(2)} с вместо ожидаемых ${expected.durationSeconds.toFixed(2)} с`,
    );
  }

  const formatName = probe.format?.format_name ?? '';
  if (!/mp4|mov/.test(formatName)) problems.push(`контейнер ${formatName} вместо mp4`);

  return {
    ok: problems.length === 0,
    problems,
    info: {
      durationSeconds: Number.isFinite(duration) ? Number(duration.toFixed(3)) : null,
      width: Number(video?.width) || null,
      height: Number(video?.height) || null,
      fps: video ? frameRateOf(video) : null,
      videoCodec: video?.codec_name ?? null,
      audioCodec: audio?.codec_name ?? null,
      pixelFormat: video?.pix_fmt ?? null,
      formatName,
      sizeBytes: Number(probe.format?.size) || null,
      bitrate: Number(probe.format?.bit_rate) || null,
    },
  };
}
