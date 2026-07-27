import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildAudioGraph } from '../../src/audio.js';
import { JOIN_FADE_MS, LOUDNESS_TARGET_LUFS } from '../../src/contract.js';
import { buildTimeline } from '../../src/timeline.js';
import { fullCapabilities } from '../helpers/fixtures.js';

const clip = (id, mediaId, duration, transition = { type: 'cut' }, type = 'video') => ({
  id,
  mediaId,
  duration,
  transition,
  type,
});

function graph(clips, sourceSpec, opts = {}) {
  const timeline = buildTimeline(clips);
  const sources = new Map(
    Object.entries(sourceSpec).map(([mediaId, hasAudio]) => [mediaId, { hasAudio }]),
  );
  return {
    timeline,
    result: buildAudioGraph({
      segments: timeline.segments,
      sources,
      keepOriginal: opts.keepOriginal ?? true,
      capabilities: fullCapabilities(opts.capabilities),
    }),
  };
}

test('keepOriginal: false — аудиопотока нет вовсе', () => {
  const { result } = graph([clip('c1', 'a', 3), clip('c2', 'b', 3)], { a: true, b: true }, {
    keepOriginal: false,
  });

  assert.equal(result.enabled, false);
  assert.equal(result.outLabel, null);
  assert.deepEqual(result.filters, [], 'звуковых фильтров быть не должно');
});

test('keepOriginal: true — дорожки склеиваются и нормализуются', () => {
  const { result } = graph([clip('c1', 'a', 3), clip('c2', 'b', 3)], { a: true, b: true });

  assert.equal(result.enabled, true);
  assert.equal(result.outLabel, 'aout');
  assert.equal(result.hasRealAudio, true);

  const chain = result.filters.join(';');
  assert.match(chain, /\[0:a\]/, 'дорожка первого клипа взята из входа');
  assert.match(chain, /\[1:a\]/);
  assert.match(chain, new RegExp(`loudnorm=I=${LOUDNESS_TARGET_LUFS}`));
  assert.match(chain, /alimiter=limit=0\.95/);
});

test('музыки в тракте нет ни при каких настройках', () => {
  const { result } = graph([clip('c1', 'a', 3), clip('c2', 'b', 3)], { a: true, b: true });
  const chain = result.filters.join(';');

  for (const forbidden of ['amix', 'sidechaincompress', 'aevalsrc', 'asplit', 'volume=']) {
    assert.ok(!chain.includes(forbidden), `в звуковом тракте не должно быть ${forbidden}`);
  }
});

test('материал без звука занимает свой отрезок тишиной — иначе съедет синхрон', () => {
  const { result } = graph([clip('c1', 'a', 3), clip('c2', 'b', 2)], { a: true, b: false });
  const chain = result.filters.join(';');

  assert.equal(result.enabled, true);
  assert.match(chain, /anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:2\.000/);
});

test('фото не получает искусственной дорожки — только выравнивание тишиной', () => {
  const { result } = graph(
    [clip('c1', 'a', 3), clip('c2', 'b', 2, { type: 'cut' }, 'photo')],
    { a: true, b: false },
  );
  const chain = result.filters.join(';');

  // Никакого синтезированного содержимого: только anullsrc нужной длины.
  assert.match(chain, /anullsrc/);
  assert.ok(!chain.includes('aevalsrc'), 'звук для фото не синтезируется');
  assert.ok(!chain.includes('sine'), 'звук для фото не синтезируется');
});

test('ролик целиком из материалов без звука экспортируется без дорожки', () => {
  const { result } = graph(
    [clip('c1', 'a', 3, { type: 'cut' }, 'photo'), clip('c2', 'b', 3, { type: 'cut' }, 'photo')],
    { a: false, b: false },
  );

  assert.equal(result.enabled, false);
  assert.equal(result.hasRealAudio, false);
  assert.ok(result.notes.some((n) => n.startsWith('audio-omitted:')));
});

test('немые видео тоже дают ролик без дорожки', () => {
  const { result } = graph([clip('c1', 'a', 3), clip('c2', 'b', 3)], { a: false, b: false });
  assert.equal(result.enabled, false);
});

// ── Щелчки на стыках (§1.2) ───────────────────────────────────────────────

test('на стыке cut ставится микрофейд с обеих сторон', () => {
  const { result } = graph([clip('c1', 'a', 3), clip('c2', 'b', 3)], { a: true, b: true });
  const chain = result.filters.join(';');
  const seconds = (JOIN_FADE_MS / 1000).toString();

  // Первый клип: фейд на входе (начало ролика) и на выходе (стык).
  assert.match(chain, new RegExp(`afade=t=in:st=0:d=${seconds}`));
  assert.match(chain, new RegExp(`afade=t=out:st=2\\.985:d=${seconds}`));
  assert.match(chain, /concat=n=2:v=0:a=1/);
});

test('на плавном переходе микрофейда нет — там работает acrossfade', () => {
  const { result, timeline } = graph(
    [clip('c1', 'a', 3), clip('c2', 'b', 3, { type: 'dissolve', durationSeconds: 0.5 })],
    { a: true, b: true },
  );
  const chain = result.filters.join(';');

  assert.match(chain, new RegExp(`acrossfade=d=${timeline.segments[1].overlap.toFixed(3)}`));
  // Второй клип входит через acrossfade — фейда на его входе быть не должно.
  const secondClip = result.filters.find((f) => f.startsWith('[1:a]'));
  assert.ok(!secondClip.includes('afade=t=in'), 'двойной фейд дал бы провал громкости');
});

test('первый и последний клип всегда получают фейд — от щелчка на краях ролика', () => {
  const { result } = graph(
    [
      clip('c1', 'a', 3),
      clip('c2', 'b', 3, { type: 'dissolve', durationSeconds: 0.5 }),
      clip('c3', 'c', 3, { type: 'dissolve', durationSeconds: 0.5 }),
    ],
    { a: true, b: true, c: true },
  );

  const first = result.filters.find((f) => f.startsWith('[0:a]'));
  const last = result.filters.find((f) => f.startsWith('[2:a]'));
  assert.match(first, /afade=t=in:st=0/);
  assert.match(last, /afade=t=out/);
});

test('дорожка подгоняется под длину клипа: короткая добирается, длинная режется', () => {
  const { result } = graph([clip('c1', 'a', 2.5), clip('c2', 'b', 3)], { a: true, b: true });
  const chain = result.filters.join(';');

  assert.match(chain, /apad=whole_dur=2\.500/);
  assert.match(chain, /atrim=0:2\.500/);
});

test('дорожка приводится к 48 кГц stereo — иначе склейка развалится', () => {
  const { result } = graph([clip('c1', 'a', 3), clip('c2', 'b', 3)], { a: true, b: true });
  const chain = result.filters.join(';');

  assert.match(chain, /aresample=48000:async=1:first_pts=0/);
  assert.match(chain, /aformat=sample_fmts=fltp:channel_layouts=stereo:sample_rates=48000/);
});

test('без loudnorm рендер продолжается с пометкой', () => {
  const { result } = graph([clip('c1', 'a', 3)], { a: true }, { capabilities: { loudnorm: false } });
  assert.equal(result.enabled, true);
  assert.ok(!result.filters.join(';').includes('loudnorm'));
  assert.ok(result.notes.some((n) => n.startsWith('loudnorm-unavailable:')));
});

test('без acrossfade плавный стык склеивается встык с пометкой', () => {
  const { result } = graph(
    [clip('c1', 'a', 3), clip('c2', 'b', 3, { type: 'dissolve', durationSeconds: 0.5 })],
    { a: true, b: true },
    { capabilities: { acrossfade: false } },
  );

  assert.match(result.filters.join(';'), /concat=n=2:v=0:a=1/);
  assert.ok(result.notes.some((n) => n.startsWith('audio-join:')));
});

test('число аудиосегментов совпадает с числом клипов — синхрон держится на этом', () => {
  const clips = [
    clip('c1', 'a', 3),
    clip('c2', 'b', 2, { type: 'dissolve', durationSeconds: 0.4 }),
    clip('c3', 'c', 4),
  ];
  const { result } = graph(clips, { a: true, b: false, c: true });

  const segmentFilters = result.filters.filter((f) => /\[a\d+\]$/.test(f));
  assert.equal(segmentFilters.length, clips.length);
});
