// Раскладка клипов по таймлайну с учётом перекрытий на переходах (§3 v2).
//
// Ключевой момент: `cut` стыкует клипы встык, а любой плавный переход требует
// перекрытия — второй клип начинается ДО конца первого. Поэтому итоговая
// длительность ролика меньше Σ clips[].duration ровно на сумму перекрытий.
//
// Эта функция — единственный источник истины о том, где какой клип стоит. Её
// результат используют граф видео, граф звука, тайминги субтитров и текстовых
// слоёв, а также проверка длительности готового MP4. Именно поэтому
// аудиотаймлайн гарантированно совпадает с видео: он строится из тех же
// сегментов, что и картинка.

import { canonicalTransition, resolveTransitionDuration } from './transitions.js';

/**
 * @param {{id: string, duration: number,
 *          transition: {type: string, durationSeconds: number|null, intensity: string}}[]} clips
 * @returns {{segments: object[], totalDuration: number, notes: string[]}}
 */
export function buildTimeline(clips) {
  const segments = [];
  const notes = [];
  let cursor = 0;

  clips.forEach((clip, index) => {
    const requested = clip.transition ?? { type: 'cut', durationSeconds: null };
    const type = canonicalTransition(requested.type);

    let overlap = 0;
    // Первому клипу накладываться не на что, `cut` перекрытия не даёт.
    if (index > 0 && type !== 'cut') {
      const resolved = resolveTransitionDuration({
        requestedSeconds: requested.durationSeconds,
        intensity: requested.intensity,
        prevDuration: clips[index - 1].duration,
        nextDuration: clip.duration,
      });
      overlap = resolved.seconds;
      if (resolved.clampedBy === 'degraded-to-cut') {
        notes.push(`transition-degraded: ${clip.id} слишком короткий клип, переход стал стыком`);
      }
    }

    const start = index === 0 ? 0 : cursor - overlap;
    const end = start + clip.duration;

    segments.push({
      index,
      id: clip.id,
      clip,
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
      // Фактический тип: если перекрытие схлопнулось, это уже стык.
      transition: index === 0 || overlap === 0 ? 'cut' : type,
      requestedTransition: type,
      overlap,
    });
    cursor = end;
  });

  return { segments, totalDuration: Number(cursor.toFixed(3)), notes };
}

/**
 * Абсолютное время на таймлайне для текстового слоя или реплики, привязанной
 * к клипу (§4). Без привязки время уже абсолютное.
 */
export function resolveClipTime(segments, clipId, offsetSeconds) {
  if (!clipId) return offsetSeconds;
  const segment = segments.find((s) => s.id === clipId);
  if (!segment) return offsetSeconds;
  return Number((segment.start + offsetSeconds).toFixed(3));
}
