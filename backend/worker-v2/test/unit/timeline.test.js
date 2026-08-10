import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildTimeline, resolveClipTime } from '../../src/timeline.js';

const clip = (id, duration, transition = { type: 'cut' }) => ({ id, duration, transition });
const smooth = (durationSeconds = 0.45) => ({ type: 'dissolve', durationSeconds });

test('cut стыкует клипы встык — длительность равна сумме', () => {
  const { segments, totalDuration } = buildTimeline([clip('a', 3), clip('b', 2), clip('c', 4)]);

  assert.equal(totalDuration, 9);
  assert.deepEqual(
    segments.map((s) => [s.start, s.end]),
    [
      [0, 3],
      [3, 5],
      [5, 9],
    ],
  );
  assert.ok(segments.every((s) => s.overlap === 0));
});

test('плавный переход укорачивает ролик ровно на перекрытие', () => {
  const { segments, totalDuration } = buildTimeline([clip('a', 3), clip('b', 3, smooth(0.5))]);

  assert.equal(segments[1].overlap, 0.5);
  assert.equal(segments[1].start, 2.5);
  assert.equal(totalDuration, 5.5);
});

test('первый клип никогда не перекрывается — накладывать не на что', () => {
  const { segments } = buildTimeline([clip('a', 3, smooth()), clip('b', 3)]);
  assert.equal(segments[0].overlap, 0);
  assert.equal(segments[0].start, 0);
  assert.equal(segments[0].transition, 'cut');
});

test('интенсивность задаёт перекрытие, если длительность не указана', () => {
  const calm = buildTimeline([clip('a', 5), clip('b', 5, { type: 'dissolve', intensity: 'calm' })]);
  const dynamic = buildTimeline([
    clip('a', 5),
    clip('b', 5, { type: 'dissolve', intensity: 'dynamic' }),
  ]);

  assert.equal(calm.segments[1].overlap, 0.8);
  assert.equal(dynamic.segments[1].overlap, 0.25);
  assert.ok(calm.totalDuration < dynamic.totalDuration, 'спокойные переходы съедают больше');
});

test('синоним crossfade даёт тот же таймлайн, что и dissolve', () => {
  const a = buildTimeline([clip('a', 3), clip('b', 3, { type: 'crossfade', durationSeconds: 0.5 })]);
  const b = buildTimeline([clip('a', 3), clip('b', 3, { type: 'dissolve', durationSeconds: 0.5 })]);
  assert.equal(a.totalDuration, b.totalDuration);
  assert.equal(a.segments[1].transition, b.segments[1].transition);
});

test('слишком короткий клип вырождает переход в стык и сообщает об этом', () => {
  const { segments, totalDuration, notes } = buildTimeline([clip('a', 4), clip('b', 0.3, smooth())]);

  assert.equal(segments[1].overlap, 0);
  assert.equal(segments[1].transition, 'cut');
  assert.equal(totalDuration, 4.3);
  assert.ok(notes.some((n) => n.startsWith('transition-degraded:')));
});

test('запрошенный тип сохраняется даже после вырождения в стык', () => {
  const { segments } = buildTimeline([clip('a', 4), clip('b', 0.3, { type: 'zoomIn' })]);
  assert.equal(segments[1].transition, 'cut');
  assert.equal(segments[1].requestedTransition, 'zoomIn');
});

test('сегменты идут монотонно и покрывают весь таймлайн', () => {
  const { segments, totalDuration } = buildTimeline([
    clip('a', 3),
    clip('b', 2.5, { type: 'fadeBlack', durationSeconds: 0.4 }),
    clip('c', 4, { type: 'zoomIn', durationSeconds: 0.6 }),
    clip('d', 2),
  ]);

  for (let i = 1; i < segments.length; i += 1) {
    assert.ok(segments[i].start > segments[i - 1].start, 'старты возрастают');
  }
  assert.equal(segments.at(-1).end, totalDuration);
  assert.equal(segments[0].start, 0);
});

test('перекрытие не длиннее 40% более короткого соседа', () => {
  const { segments } = buildTimeline([clip('a', 10), clip('b', 1, smooth(1.5))]);
  assert.equal(segments[1].overlap, 0.4);
});

test('время, привязанное к клипу, переводится в абсолютное', () => {
  const { segments } = buildTimeline([clip('a', 3), clip('b', 4)]);

  assert.equal(resolveClipTime(segments, 'clip_b', 1), 1, 'неизвестный клип — время как есть');
  assert.equal(resolveClipTime(segments, 'b', 1), 4);
  assert.equal(resolveClipTime(segments, null, 2.5), 2.5);
});

test('один клип даёт таймлайн своей длины без перекрытий', () => {
  const { segments, totalDuration } = buildTimeline([clip('a', 7.5, smooth())]);
  assert.equal(totalDuration, 7.5);
  assert.equal(segments[0].overlap, 0);
});
