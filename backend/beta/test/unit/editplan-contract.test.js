// Контракт EditPlan v2: producer-сторона (§ фикс client↔server plan mismatch).
//
// Проверяет, что СЕРВЕР формирует именно ту схему, которую читает Flutter
// (та же общая фикстура test-fixtures/edit_plan_v2.json). Клипы адресуют
// материал по mediaId, filePath НЕ отдаётся, а transition — ОБЪЕКТ
// {type, durationSeconds, intensity}, а не строка.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { assemblePlan } from '../../src/editplan.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, '../../../../test-fixtures/edit_plan_v2.json');

/** Тестовые анализы материалов (форма validateMediaAnalysis). */
const analyses = [
  {
    assetId: 'asset_a',
    type: 'video',
    durationSeconds: 12,
    quality: { overall: 0.8 },
    scenes: [{ start: 0, end: 6, quality: 0.8, motion: 'slow' }],
    moments: [{ start: 0, end: 6, kind: 'highlight', score: 0.9 }],
    speech: { segments: [] },
  },
  {
    assetId: 'asset_b',
    type: 'video',
    durationSeconds: 10,
    quality: { overall: 0.7 },
    scenes: [{ start: 2, end: 6, quality: 0.7, motion: 'fast' }],
    moments: [{ start: 2, end: 6, kind: 'highlight', score: 0.7 }],
    speech: { segments: [] },
  },
];

const CLIP_KEYS = ['id', 'mediaId', 'type', 'duration', 'start', 'end', 'transition'];
const TRANSITION_KEYS = ['type', 'durationSeconds', 'intensity'];

function assertClipSchema(clip, where) {
  assert.equal(typeof clip.id, 'string', `${where}: id`);
  assert.equal(typeof clip.mediaId, 'string', `${where}: mediaId (адресация материала)`);
  assert.ok(clip.mediaId.length > 0, `${where}: mediaId непустой`);
  assert.ok(['video', 'photo'].includes(clip.type), `${where}: type`);
  assert.equal(typeof clip.duration, 'number', `${where}: duration число`);
  assert.ok(clip.duration > 0, `${where}: duration > 0`);
  // filePath НИКОГДА не в серверном плане.
  assert.ok(!('filePath' in clip), `${where}: filePath не отдаётся сервером`);
  // transition — ОБЪЕКТ v2, не строка.
  assert.equal(typeof clip.transition, 'object', `${where}: transition — объект`);
  assert.ok(clip.transition !== null, `${where}: transition не null`);
  for (const k of TRANSITION_KEYS) {
    assert.ok(k in clip.transition, `${where}: transition.${k}`);
  }
  assert.equal(typeof clip.transition.type, 'string', `${where}: transition.type строка`);
}

test('assemblePlan формирует схему v2: клипы по mediaId, transition-объект, без filePath', () => {
  const { plan } = assemblePlan({ planId: 'plan_test', prompt: 'x', analyses, targetDurationSeconds: 20 });

  assert.equal(typeof plan.id, 'string');
  assert.equal(typeof plan.audio?.keepOriginal, 'boolean', 'audio.keepOriginal');
  assert.ok(Array.isArray(plan.textOverlays), 'textOverlays массив');
  assert.ok(Array.isArray(plan.clips) && plan.clips.length > 0, 'clips непустой');

  plan.clips.forEach((clip, i) => assertClipSchema(clip, `assemblePlan.clips[${i}]`));
  // Первый клип — стык (без перехода) по контракту.
  assert.equal(plan.clips[0].transition.type, 'cut', 'первый клип — cut');
});

test('общая фикстура v2 совпадает со схемой producer (один канонический формат)', () => {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  assert.ok(Array.isArray(fixture.clips) && fixture.clips.length > 0);
  assert.equal(typeof fixture.audio?.keepOriginal, 'boolean');
  fixture.clips.forEach((clip, i) => {
    // Ровно те же ключи клипа, что и у producer (порядок неважен).
    assert.deepEqual(Object.keys(clip).sort(), [...CLIP_KEYS].sort(), `fixture.clips[${i}] keys`);
    assertClipSchema(clip, `fixture.clips[${i}]`);
  });
  // Фикстура несёт полноценный transition-объект с параметрами (не только type).
  const withParams = fixture.clips.find((c) => c.transition.durationSeconds !== null);
  assert.ok(withParams, 'фикстура содержит клип с durationSeconds перехода');
  assert.ok(['calm', 'balanced', 'dynamic'].includes(withParams.transition.intensity));
});
