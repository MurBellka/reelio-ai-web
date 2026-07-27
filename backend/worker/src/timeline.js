// Раскладка клипов по таймлайну с учётом перекрытий на переходах.
//
// Ключевой момент: `cut` стыкует клипы встык, а любой плавный переход требует
// перекрытия — второй клип начинается ДО конца первого. Поэтому итоговая
// длительность ролика меньше Σ clips[].duration ровно на сумму перекрытий.
// Эта функция — единственный источник истины о том, где какой клип стоит:
// её результат используют и filter_complex, и тайминги субтитров, и проверка
// длительности готового MP4.

/** Максимальное перекрытие перехода, с. */
export const MAX_TRANSITION_SECONDS = 0.6;
/** Минимальное — короче незаметно и ломает xfade. */
export const MIN_TRANSITION_SECONDS = 0.15;

/**
 * Длительность перехода между соседними клипами: не длиннее 40% более
 * короткого из них, чтобы переход не «съел» клип целиком.
 */
export function transitionDuration(prevDuration, nextDuration) {
  const limit = 0.4 * Math.min(prevDuration, nextDuration);
  const value = Math.min(MAX_TRANSITION_SECONDS, limit);
  return value >= MIN_TRANSITION_SECONDS ? Number(value.toFixed(3)) : 0;
}

/**
 * @param {{id: string, duration: number, transition: string}[]} clips
 * @returns {{segments: {index: number, id: string, clip: object, start: number,
 *            end: number, transition: string, overlap: number}[],
 *           totalDuration: number}}
 */
export function buildTimeline(clips) {
  const segments = [];
  let cursor = 0;

  clips.forEach((clip, index) => {
    // `cut` (и первый клип) перекрытия не дают.
    const overlap =
      index === 0 || clip.transition === 'cut'
        ? 0
        : transitionDuration(clips[index - 1].duration, clip.duration);

    const start = index === 0 ? 0 : cursor - overlap;
    const end = start + clip.duration;

    segments.push({
      index,
      id: clip.id,
      clip,
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
      transition: index === 0 ? 'cut' : clip.transition,
      overlap,
    });
    cursor = end;
  });

  return { segments, totalDuration: Number(cursor.toFixed(3)) };
}
