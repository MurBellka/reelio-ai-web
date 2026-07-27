import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildTimeline, transitionDuration } from '../../src/timeline.js';

const clip = (id, duration, transition = 'cut') => ({ id, duration, transition });

test('cut стыкует клипы встык — длительность равна сумме', () => {
  const { segments, totalDuration } = buildTimeline([
    clip('a', 3),
    clip('b', 2),
    clip('c', 4),
  ]);
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
  const { segments, totalDuration } = buildTimeline([clip('a', 3), clip('b', 3, 'crossfade')]);
  const overlap = segments[1].overlap;
  assert.ok(overlap > 0, 'перекрытие должно быть положительным');
  assert.equal(segments[1].start, Number((3 - overlap).toFixed(3)));
  assert.equal(totalDuration, Number((6 - overlap).toFixed(3)));
});

test('первый клип никогда не перекрывается — накладывать не на что', () => {
  const { segments } = buildTimeline([clip('a', 3, 'crossfade'), clip('b', 3)]);
  assert.equal(segments[0].overlap, 0);
  assert.equal(segments[0].start, 0);
  assert.equal(segments[0].transition, 'cut');
});

test('перекрытие не длиннее 40% короткого клипа', () => {
  // Клип 0.5 с: 40% = 0.2 с.
  assert.equal(transitionDuration(5, 0.5), 0.2);
  // Длинные клипы упираются в общий потолок 0.6 с.
  assert.equal(transitionDuration(10, 10), 0.6);
});

test('слишком короткий клип превращает переход в стык', () => {
  // 40% от 0.3 с = 0.12 с — меньше минимума 0.15 с.
  assert.equal(transitionDuration(4, 0.3), 0);
  const { segments } = buildTimeline([clip('a', 4), clip('b', 0.3, 'slide')]);
  assert.equal(segments[1].overlap, 0);
  assert.equal(segments[1].start, 4);
});

test('сегменты идут монотонно и покрывают весь таймлайн', () => {
  const { segments, totalDuration } = buildTimeline([
    clip('a', 3),
    clip('b', 2.5, 'fade'),
    clip('c', 4, 'zoom'),
    clip('d', 2, 'cut'),
  ]);
  for (let i = 1; i < segments.length; i += 1) {
    assert.ok(segments[i].start > segments[i - 1].start, 'старты возрастают');
    assert.ok(segments[i].start < segments[i - 1].end || segments[i].overlap === 0);
  }
  assert.equal(segments.at(-1).end, totalDuration);
});
