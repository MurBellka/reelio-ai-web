// Проверка ЗАГРУЖЕННЫХ файлов перед запуском платного рендера.
//
// Расширению и Content-Type верить нельзя: и то и другое задаёт клиент. Здесь
// файл проверяется по фактическому содержимому через ffprobe, и всё, что не
// прошло, немедленно удаляется из бакета — хранить чужой мусор мы не обязаны.
//
// ffprobe читает объект по короткоживущей подписанной ссылке и делает
// range-запросы, поэтому двухгигабайтный файл не нужно скачивать целиком.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ApiError } from './errors.js';

const exec = promisify(execFile);

/**
 * Путь к ffprobe. В образе Cloud Run (buildpacks) системного ffprobe нет,
 * поэтому запасной вариант — бинарник из пакета ffprobe-static. Разрешается
 * один раз и кэшируется: это обращение к диску, а не к сети.
 */
let resolvedFfprobe;
async function resolveFfprobe(preferred) {
  if (resolvedFfprobe) return resolvedFfprobe;
  const candidates = [preferred].filter(Boolean);
  try {
    const mod = await import('ffprobe-static');
    const bundled = mod.default?.path ?? mod.path;
    if (bundled) candidates.push(bundled);
  } catch {
    // Пакета нет — остаётся системный ffprobe.
  }
  for (const candidate of candidates) {
    try {
      await exec(candidate, ['-version'], { timeout: 10_000 });
      // Сборка обязана уметь https: файл читается по подписанной ссылке.
      // Без этого протокола probe падает с пустым stderr, что выглядит как
      // «битый файл» и уводит диагностику в сторону.
      let httpsOk = false;
      try {
        const { stdout } = await exec(candidate, ['-protocols'], { timeout: 10_000 });
        httpsOk = /^\s*https\s*$/m.test(stdout);
      } catch {
        // Список протоколов недоступен — пойдём дальше и узнаем на практике.
      }
      console.log(`[media] ffprobe=${candidate} https=${httpsOk}`);
      resolvedFfprobe = candidate;
      return candidate;
    } catch {
      // Пробуем следующий.
    }
  }
  throw new ApiError(
    'INTERNAL',
    'Проверка медиафайлов недоступна на сервере.',
  );
}

/** Контейнеры/кодеки, которые мы готовы принять. */
const ALLOWED_VIDEO_CODECS = new Set([
  'h264', 'hevc', 'vp8', 'vp9', 'av1', 'mpeg4', 'mpeg2video', 'mjpeg', 'prores',
]);
const ALLOWED_IMAGE_CODECS = new Set([
  'mjpeg', 'png', 'webp', 'bmp', 'tiff', 'gif', 'hevc', 'jpeg2000',
]);

/**
 * Запускает ffprobe и возвращает разобранные потоки.
 * Таймаут обязателен: битый файл может подвесить probe надолго.
 */
async function probe(url, { ffprobePath, timeoutMs }) {
  const binary = await resolveFfprobe(ffprobePath);
  const args = [
    '-v', 'error',
    '-print_format', 'json',
    '-show_streams',
    '-show_format',
    // Ограничиваем анализ: полный разбор длинного файла стоит времени.
    '-analyzeduration', '10M',
    '-probesize', '10M',
    url,
  ];
  try {
    const { stdout } = await exec(binary, args, {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch (err) {
    // Клиенту — общая формулировка: подробности ffprobe ему не нужны, а в
    // ссылке подпись. Но в лог причину писать НУЖНО: без неё поломка
    // окружения (нет протокола, нет доступа) неотличима от битого файла.
    const detail = String(err?.stderr || err?.stdout || `exit=${err?.code} ${err?.message}` || 'unknown')
      .replace(/https?:\/\/[^\s'"]+/g, '<url-redacted>')
      .slice(0, 300);
    console.warn(`[media] ffprobe failed: ${detail}`);
    throw new ApiError(
      'MEDIA_INVALID',
      'Файл не удалось прочитать: возможно, он повреждён или это не медиафайл.',
    );
  }
}

/**
 * Проверяет один материал. Возвращает распознанные характеристики, которыми
 * дальше пользуется резолв разрешения — они берутся из файла, а не со слов
 * клиента.
 */
export async function inspectAsset({ url, declaredType, limits, ffprobePath, timeoutMs = 60_000 }) {
  const data = await probe(url, { ffprobePath, timeoutMs });

  const streams = Array.isArray(data.streams) ? data.streams : [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');

  if (!video) {
    throw new ApiError('MEDIA_INVALID', 'В файле нет изображения — он не подходит для монтажа.');
  }

  const width = Number(video.width) || 0;
  const height = Number(video.height) || 0;
  if (width <= 0 || height <= 0) {
    throw new ApiError('MEDIA_INVALID', 'Не удалось определить размер кадра.');
  }

  const sizeBytes = Number(data.format?.size) || 0;
  const duration = Number(data.format?.duration) || Number(video.duration) || 0;

  // Кадров больше одного и есть длительность → это видео, чем бы его ни назвал
  // клиент. Именно фактический тип решает, какие лимиты применять.
  const frames = Number(video.nb_frames) || 0;
  const looksLikeVideo = duration > 0.05 && (frames === 0 || frames > 1);
  const actualType = looksLikeVideo ? 'video' : 'photo';

  const allowed = actualType === 'video' ? ALLOWED_VIDEO_CODECS : ALLOWED_IMAGE_CODECS;
  if (!allowed.has(video.codec_name)) {
    throw new ApiError('MEDIA_INVALID', `Формат «${video.codec_name}» не поддерживается.`);
  }

  if (declaredType === 'photo' && actualType === 'video') {
    // Не ошибка клиента, а расхождение: считаем файл видео и применяем к нему
    // видео-лимиты, иначе десятиминутный ролик проехал бы как «фото».
    console.warn('[media] declared photo, detected video');
  }

  if (actualType === 'video' && duration > limits.maxSingleVideoSeconds) {
    throw new ApiError(
      'MEDIA_TOO_LONG',
      `Видео длиннее ${Math.round(limits.maxSingleVideoSeconds / 60)} минут не принимается.`,
    );
  }

  return {
    type: actualType,
    width,
    height,
    durationSeconds: actualType === 'video' ? duration : null,
    sizeBytes,
    videoCodec: video.codec_name,
    audioCodec: audio?.codec_name ?? null,
  };
}

/**
 * Проверяет весь набор материалов проекта и удаляет всё, что не прошло.
 *
 * Возвращает характеристики по assetId. Проектные потолки (суммарная
 * длительность, общий размер, количество файлов) считаются здесь же: по
 * отдельности файлы могут быть допустимыми, а вместе — нет.
 */
export async function validateProjectMedia({ assets, storage, limits, ffprobePath }) {
  const videos = assets.filter((a) => a.type === 'video').length;
  const photos = assets.length - videos;
  if (videos > limits.maxVideos) {
    throw new ApiError('MEDIA_INVALID', `Видео не больше ${limits.maxVideos} на проект.`);
  }
  if (photos > limits.maxPhotos) {
    throw new ApiError('MEDIA_INVALID', `Фотографий не больше ${limits.maxPhotos} на проект.`);
  }

  const results = {};
  const rejected = [];
  let totalBytes = 0;
  let totalVideoSeconds = 0;

  for (const asset of assets) {
    let info;
    try {
      const { url } = await storage.signedReadUrl(asset.objectPath, { ttlSeconds: 300 });
      info = await inspectAsset({
        url,
        declaredType: asset.type,
        limits,
        ffprobePath,
      });
    } catch (err) {
      // Непригодный файл не должен оставаться в бакете и занимать место.
      rejected.push(asset.objectPath);
      await storage.deleteObject(asset.objectPath).catch(() => {});
      throw err instanceof ApiError
        ? new ApiError(err.code, `«${asset.id}»: ${err.message}`, { field: `assets.${asset.id}` })
        : new ApiError('MEDIA_INVALID', `Материал «${asset.id}» не прошёл проверку.`);
    }

    totalBytes += info.sizeBytes;
    if (info.type === 'video') totalVideoSeconds += info.durationSeconds || 0;
    results[asset.id] = info;
  }

  if (totalBytes > limits.maxProjectBytes) {
    const gb = (limits.maxProjectBytes / 1024 ** 3).toFixed(0);
    throw new ApiError('PROJECT_TOO_LARGE', `Суммарный размер материалов больше ${gb} ГБ.`);
  }
  if (totalVideoSeconds > limits.maxProjectVideoSeconds) {
    const mins = Math.round(limits.maxProjectVideoSeconds / 60);
    throw new ApiError('MEDIA_TOO_LONG', `Суммарная длительность видео больше ${mins} минут.`);
  }

  return { byAssetId: results, totalBytes, totalVideoSeconds, rejected };
}
