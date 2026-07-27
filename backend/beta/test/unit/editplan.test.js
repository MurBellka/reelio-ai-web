import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SAFE_ZONE } from '../../src/catalog.js';
import { PlanValidationError, assemblePlan, validatePlan } from '../../src/editplan.js';
import { PROJECT_LIMITS } from '../../src/limits.js';
import { normalizeOperations } from '../../src/operations.js';
import { findMusicMention } from '../../src/prompts.js';

/** Анализ двух видео и одного фото — типичный проект. */
function analyses() {
  return [
    {
      assetId: 'asset_a',
      type: 'video',
      durationSeconds: 20,
      scenes: [
        { start: 0, end: 8, motion: 'slow', quality: 0.8 },
        { start: 8, end: 20, motion: 'fast', quality: 0.6 },
      ],
      moments: [
        { start: 1, end: 5, score: 0.9, kind: 'highlight' },
        { start: 9, end: 13, score: 0.7, kind: 'action' },
      ],
      speech: {
        hasSpeech: true,
        language: 'ru',
        segments: [{ start: 1.5, end: 3.5, text: 'Мы приехали на море', words: [] }],
      },
      quality: { overall: 0.8 },
    },
    {
      assetId: 'asset_b',
      type: 'video',
      durationSeconds: 15,
      scenes: [{ start: 0, end: 15, motion: 'moderate', quality: 0.7 }],
      moments: [{ start: 2, end: 6, score: 0.8, kind: 'highlight' }],
      speech: { hasSpeech: false, segments: [] },
      quality: { overall: 0.7 },
    },
    {
      assetId: 'asset_c',
      type: 'photo',
      durationSeconds: 0,
      scenes: [],
      moments: [],
      speech: { hasSpeech: false, segments: [] },
      quality: { overall: 0.9 },
    },
  ];
}

const assemble = (overrides = {}) =>
  assemblePlan({ planId: 'plan_1', analyses: analyses(), ...overrides });

// ── Сборка черновика ──────────────────────────────────────────────────────

test('план собирается из лучших моментов анализа', () => {
  const { plan } = assemble();

  assert.ok(plan.clips.length >= 2);
  assert.equal(plan.id, 'plan_1');
  assert.equal(plan.coverClipId, plan.clips[0].id);
  assert.ok(plan.clips.every((c) => c.duration > 0));
});

test('первый клип всегда без перехода', () => {
  const { plan } = assemble();
  assert.equal(plan.clips[0].transition.type, 'cut');
});

test('идентификаторы клипов последовательны', () => {
  const { plan } = assemble();
  assert.deepEqual(
    plan.clips.map((c) => c.id),
    plan.clips.map((_, i) => `clip_${i + 1}`),
  );
});

test('суммарная длительность не превышает заданную цель', () => {
  const { plan } = assemble({ targetDurationSeconds: 10 });
  const total = plan.clips.reduce((s, c) => s + c.duration, 0);
  assert.ok(total <= 10.001, `получилось ${total} с`);
});

test('переходы выбираются только из доступных сборке FFmpeg', () => {
  const { plan } = assemble({ verifiedTransitions: ['cut', 'dissolve'] });
  for (const clip of plan.clips) {
    assert.ok(['cut', 'dissolve'].includes(clip.transition.type), clip.transition.type);
  }
});

// ── §9: музыки нет ────────────────────────────────────────────────────────

test('§9: в собранном плане нет ни одного музыкального поля', () => {
  const { plan } = assemble();
  assert.ok(!('music' in plan));
  const found = findMusicMention(JSON.stringify(plan));
  assert.equal(found, null, `план упоминает музыку: «${found}»`);
});

test('§9: план с полем music не проходит валидацию', () => {
  const { plan } = assemble();
  plan.music = { track: 'chill', volume: 0.7 };
  assert.throws(() => validatePlan(plan), PlanValidationError);
});

test('§1 v2: звук по умолчанию — оригинальный', () => {
  assert.equal(assemble().plan.audio.keepOriginal, true);
});

// ── Применение команд ─────────────────────────────────────────────────────

function withOps(rawOps, overrides = {}) {
  const draft = assemble(overrides);
  const clipIds = new Set(draft.plan.clips.map((c) => c.id));
  const textIds = new Set(draft.plan.textOverlays.map((t) => t.id));
  const { operations } = normalizeOperations(
    { operations: rawOps },
    { clipIds, textIds, maxDuration: PROJECT_LIMITS.maxOutputDurationSeconds },
  );
  return assemble({ ...overrides, operations });
}

test('команда «поставь текст» добавляет слой', () => {
  const { plan } = withOps([
    {
      op: 'addText',
      text: 'Наша поездка',
      startSeconds: 3,
      endSeconds: 6,
      anchor: 'top',
      fontId: 'montserrat',
      animation: 'fade',
    },
  ]);

  assert.equal(plan.textOverlays.length, 1);
  assert.equal(plan.textOverlays[0].text, 'Наша поездка');
  assert.equal(plan.textOverlays[0].fontId, 'montserrat');
  assert.equal(plan.textOverlays[0].animation, 'fade');
});

test('команда «экспортируй без звука» выключает звук', () => {
  assert.equal(withOps([{ op: 'setAudio', keepOriginal: false }]).plan.audio.keepOriginal, false);
});

test('команда «убери фрагмент» удаляет клип и перенумеровывает остальные', () => {
  const before = assemble().plan.clips.length;
  const { plan } = withOps([{ op: 'removeClip', clipId: 'clip_1' }]);

  assert.equal(plan.clips.length, before - 1);
  assert.equal(plan.clips[0].id, 'clip_1', 'после удаления нумерация начинается заново');
});

test('единственный клип удалить нельзя', () => {
  const single = [analyses()[0]];
  const draft = assemblePlan({ planId: 'p', analyses: single, targetDurationSeconds: 5 });
  const clipIds = new Set(draft.plan.clips.map((c) => c.id));
  const { operations } = normalizeOperations(
    { operations: draft.plan.clips.map((c) => ({ op: 'removeClip', clipId: c.id })) },
    { clipIds, textIds: new Set(), maxDuration: 120 },
  );

  const { plan, warnings } = assemblePlan({
    planId: 'p',
    analyses: single,
    targetDurationSeconds: 5,
    operations,
  });
  assert.ok(plan.clips.length >= 1);
  assert.ok(warnings.some((w) => w.includes('единственный')));
});

test('команда «переставь» меняет порядок и не теряет клипы', () => {
  const before = assemble().plan;
  const ids = before.clips.map((c) => c.id);
  const { plan } = withOps([{ op: 'reorderClips', order: [ids.at(-1), ids[0]] }]);

  assert.equal(plan.clips.length, before.clips.length, 'ни один клип не потерян');
  assert.equal(plan.clips[0].mediaId, before.clips.at(-1).mediaId);
});

test('команда «выбери переход» применяется, кроме первого клипа', () => {
  const { plan, warnings } = withOps([
    { op: 'setTransition', clipId: 'clip_2', transitionType: 'circleOpen', durationSeconds: 0.5 },
    { op: 'setTransition', clipId: 'clip_1', transitionType: 'zoomIn' },
  ]);

  assert.equal(plan.clips[1].transition.type, 'circleOpen');
  assert.equal(plan.clips[0].transition.type, 'cut');
  assert.ok(warnings.some((w) => w.includes('первого клипа')));
});

test('команда «ускорь начало» обрезает клип', () => {
  const { plan } = withOps([
    { op: 'trimClip', clipId: 'clip_1', startSeconds: 3, endSeconds: 5 },
  ]);
  assert.equal(plan.clips[0].duration, 2);
  assert.equal(plan.clips[0].start, 3);
});

test('команда «настрой субтитры» применяется', () => {
  const { plan } = withOps([
    { op: 'setCaptions', style: 'karaoke', position: 'top', highlightColorHex: '#a855f7' },
  ]);
  assert.equal(plan.captions.style, 'karaoke');
  assert.equal(plan.captions.position, 'top');
  assert.equal(plan.captions.highlightColorHex, '#A855F7');
});

// ── Субтитры из речи ──────────────────────────────────────────────────────

test('реплики из распознанной речи попадают в план со сдвигом на таймлайн', () => {
  const { plan } = assemble();
  assert.ok(plan.captions.cues.length >= 1);

  for (const cue of plan.captions.cues) {
    assert.ok(cue.start >= 0);
    assert.ok(cue.end > cue.start);
    assert.ok(cue.text.length > 0);
  }
});

test('выключенные субтитры очищают реплики', () => {
  const { plan } = withOps([{ op: 'setCaptions', enabled: false }]);
  assert.equal(plan.captions.enabled, false);
  assert.deepEqual(plan.captions.cues, []);
});

// ── Безопасная зона и валидация ───────────────────────────────────────────

test('§4.2: текст за безопасной зоной сдвигается с предупреждением', () => {
  const { plan, warnings } = withOps([
    { op: 'addText', text: 'Низко', startSeconds: 0, endSeconds: 3, x: 0.5, y: 0.99 },
  ]);

  assert.equal(plan.textOverlays[0].position.y, 1 - SAFE_ZONE.bottom);
  assert.ok(warnings.some((w) => w.includes('безопасную зону')));
});

test('план без клипов не проходит валидацию', () => {
  assert.throws(() => validatePlan({ clips: [], textOverlays: [], captions: {}, audio: {} }), PlanValidationError);
});

test('превышение потолка длительности не проходит валидацию', () => {
  const { plan } = assemble();
  plan.clips[0].duration = 200;
  assert.throws(
    () => validatePlan(plan),
    (err) => {
      assert.match(err.message, /120/);
      return true;
    },
  );
});

test('план без режима звука не проходит валидацию', () => {
  const { plan } = assemble();
  delete plan.audio.keepOriginal;
  assert.throws(() => validatePlan(plan), PlanValidationError);
});

test('§15: путь, просочившийся в план, ловится финальной проверкой', () => {
  const { plan } = assemble();
  plan.clips[0].mediaId = 'gs://bucket/secret.mp4';
  assert.throws(
    () => validatePlan(plan),
    (err) => {
      assert.equal(err.code, 'MODEL_OUTPUT_REJECTED');
      return true;
    },
  );
});

test('пустой анализ не даёт собрать план', () => {
  assert.throws(
    () => assemblePlan({ planId: 'p', analyses: [] }),
    PlanValidationError,
  );
});

test('привязка текста к клипу переживает перенумерацию', () => {
  const before = assemble().plan;
  const lastId = before.clips.at(-1).id;

  const clipIds = new Set(before.clips.map((c) => c.id));
  const { operations } = normalizeOperations(
    {
      operations: [
        { op: 'addText', text: 'В конце', clipId: lastId, startSeconds: 0, endSeconds: 1 },
        { op: 'removeClip', clipId: 'clip_1' },
      ],
    },
    { clipIds, textIds: new Set(), maxDuration: 120 },
  );

  const { plan } = assemble({ operations });
  const overlay = plan.textOverlays[0];
  assert.ok(
    plan.clips.some((c) => c.id === overlay.clipId),
    `привязка «${overlay.clipId}» указывает в никуда`,
  );
});
