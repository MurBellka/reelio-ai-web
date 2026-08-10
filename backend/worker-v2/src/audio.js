// Звуковой тракт (§1 контракта v2).
//
// Фоновой музыки в продукте больше нет: пользователь накладывает трендовый
// трек уже внутри Instagram. Поэтому здесь нет ни загрузки, ни синтеза, ни
// микширования — только оригинальный звук исходников либо его полное
// отсутствие.
//
// Переключатель `audio.keepOriginal`:
//   true  — дорожки клипов склеиваются в порядке монтажа, без щелчков,
//           с нормализацией громкости и защитой от клиппинга;
//   false — в MP4 вообще нет аудиопотока.
//
// Синхронизация держится на том, что аудиосегменты строятся из тех же
// segments таймлайна, что и видео: каждый клип занимает ровно свой отрезок.

import { JOIN_FADE_MS, LOUDNESS_TARGET_LUFS, LOUDNESS_TRUE_PEAK_DB } from './contract.js';

/** Формат, к которому приводится каждая дорожка перед склейкой. */
const AUDIO_FORMAT = 'aformat=sample_fmts=fltp:channel_layouts=stereo:sample_rates=48000';

/**
 * Микрофейд на «сухом» стыке. На плавном переходе его не ставим: там уже
 * работает acrossfade, и второй фейд дал бы заметный провал громкости.
 */
const JOIN_FADE_SECONDS = JOIN_FADE_MS / 1000;

/**
 * Нужен ли клипу микрофейд с каждой стороны.
 *
 * Фейд ставится там, где волна обрывается резко: в начале ролика, в конце
 * ролика и на каждом стыке `cut`. Именно эти обрывы и дают щелчок.
 */
function joinFades(segments, index) {
  const isFirst = index === 0;
  const isLast = index === segments.length - 1;
  // Перекрытие текущего сегмента описывает переход, которым он ВХОДИТ.
  const fadeIn = isFirst || segments[index].overlap === 0;
  const fadeOut = isLast || segments[index + 1].overlap === 0;
  return { fadeIn, fadeOut };
}

/** Цепочка одного клипа: реальная дорожка либо тишина ровно на его длину. */
function clipChain(segment, source, index, segments) {
  const duration = segment.clip.duration;
  const d = duration.toFixed(3);
  const label = `a${index}`;
  const hasAudio = segment.clip.type === 'video' && source?.hasAudio;

  const parts = [];

  if (hasAudio) {
    parts.push(
      // async=1 подтягивает дорожку к видео, если в исходнике плывёт PTS.
      'aresample=48000:async=1:first_pts=0',
      AUDIO_FORMAT,
      // Дорожка короче слота — добираем тишиной, длиннее — обрезаем. Иначе
      // звук последующих клипов уедет относительно картинки.
      `apad=whole_dur=${d}`,
      `atrim=0:${d}`,
      'asetpts=PTS-STARTPTS',
    );
  } else {
    // Фото и немые видео занимают свой отрезок тишиной. Это выравнивание
    // таймлайна, а не искусственная звуковая дорожка: никакого
    // синтезированного содержимого не добавляется.
    parts.push(
      `anullsrc=channel_layout=stereo:sample_rate=48000`,
      `atrim=0:${d}`,
      'asetpts=PTS-STARTPTS',
    );
  }

  const { fadeIn, fadeOut } = joinFades(segments, index);
  if (hasAudio && fadeIn) {
    parts.push(`afade=t=in:st=0:d=${JOIN_FADE_SECONDS}`);
  }
  if (hasAudio && fadeOut) {
    const start = Math.max(0, duration - JOIN_FADE_SECONDS).toFixed(3);
    parts.push(`afade=t=out:st=${start}:d=${JOIN_FADE_SECONDS}`);
  }

  const head = hasAudio ? `[${index}:a]` : '';
  return { label, filter: `${head}${parts.join(',')}[${label}]` };
}

/**
 * Полный звуковой граф.
 *
 * @param {{segments: object[], sources: Map<string, object>, keepOriginal: boolean,
 *          capabilities: object}} opts
 * @returns {{enabled: boolean, filters: string[], outLabel: string|null,
 *            hasRealAudio: boolean, notes: string[]}}
 */
export function buildAudioGraph({ segments, sources, keepOriginal, capabilities }) {
  const notes = [];

  if (!keepOriginal) {
    // §1: ролик экспортируется без аудиопотока вовсе.
    return { enabled: false, filters: [], outLabel: null, hasRealAudio: false, notes };
  }

  const hasRealAudio = segments.some(
    (s) => s.clip.type === 'video' && sources.get(s.clip.mediaId)?.hasAudio,
  );

  if (!hasRealAudio) {
    // Весь ролик из фото или из немых видео — писать дорожку тишины незачем.
    notes.push('audio-omitted: в материалах нет звука, ролик экспортирован без аудиопотока');
    return { enabled: false, filters: [], outLabel: null, hasRealAudio: false, notes };
  }

  const filters = [];
  const labels = [];

  for (const [index, segment] of segments.entries()) {
    const chain = clipChain(segment, sources.get(segment.clip.mediaId), index, segments);
    filters.push(chain.filter);
    labels.push(chain.label);
  }

  // Склейка зеркалит видео: где xfade — там acrossfade, где стык — concat.
  let acc = labels[0];
  for (let i = 1; i < segments.length; i += 1) {
    const segment = segments[i];
    const out = `ac${i}`;

    if (segment.overlap > 0 && capabilities.acrossfade) {
      filters.push(
        `[${acc}][${labels[i]}]acrossfade=d=${segment.overlap.toFixed(3)}:c1=tri:c2=tri[${out}]`,
      );
    } else {
      if (segment.overlap > 0) {
        notes.push('audio-join: сборка без acrossfade, стык склеен встык');
      }
      filters.push(`[${acc}][${labels[i]}]concat=n=2:v=0:a=1[${out}]`);
    }
    acc = out;
  }

  // Нормализация громкости: речь в исходниках записана как попало, и без неё
  // один клип оглушает, а следующий не слышно.
  if (capabilities.loudnorm) {
    filters.push(
      `[${acc}]loudnorm=I=${LOUDNESS_TARGET_LUFS}:TP=${LOUDNESS_TRUE_PEAK_DB}:LRA=11[anorm]`,
    );
    acc = 'anorm';
  } else {
    notes.push('loudnorm-unavailable: громкость не нормализована');
  }

  const tail = [];
  if (capabilities.alimiter) {
    tail.push('alimiter=limit=0.95:level=disabled');
  }
  tail.push(AUDIO_FORMAT);
  filters.push(`[${acc}]${tail.join(',')}[aout]`);

  return { enabled: true, filters, outLabel: 'aout', hasRealAudio: true, notes };
}
