import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseRenderPlan } from '../../src/plan.js';
import { makePlanDocument, makeV1PlanDocument } from '../helpers/fixtures.js';

const CTX = {
  jobId: 'job_TEST0001',
  projectId: 'proj_test',
  projectPrefix: 'projects/proj_test/',
  contractVersion: 2,
};

function expectFailure(document, code, ctx = CTX) {
  assert.throws(
    () => parseRenderPlan(document, ctx),
    (err) => {
      assert.equal(err.code, code, `ожидался код ${code}, получен ${err.code}: ${err.message}`);
      return true;
    },
  );
}

// ── План v2 ───────────────────────────────────────────────────────────────

test('валидный план v2 разбирается в render spec', () => {
  const plan = parseRenderPlan(makePlanDocument(), CTX);

  assert.equal(plan.planVersion, 2);
  assert.equal(plan.contractVersion, 2);
  assert.equal(plan.planId, 'plan_test_1');
  assert.equal(plan.clips.length, 2);
  assert.equal(plan.export.width, 720);
  assert.equal(plan.totalDuration, 6);
  assert.equal(plan.audio.keepOriginal, true);
  assert.deepEqual(plan.textOverlays, []);
});

test('переход-объект сохраняет тип, длительность и интенсивность', () => {
  const plan = parseRenderPlan(makePlanDocument(), CTX);
  assert.deepEqual(plan.clips[1].transition, {
    type: 'dissolve',
    durationSeconds: 0.45,
    intensity: 'balanced',
  });
});

test('§2.7: filePath клиента не попадает в render spec', () => {
  const plan = parseRenderPlan(makePlanDocument(), CTX);
  for (const clip of plan.clips) assert.equal(clip.filePath, undefined);
});

// ── Звук (§1 v2) ──────────────────────────────────────────────────────────

test('audio.keepOriginal читается из плана', () => {
  const off = parseRenderPlan(makePlanDocument({ plan: { audio: { keepOriginal: false } } }), CTX);
  assert.equal(off.audio.keepOriginal, false);

  const on = parseRenderPlan(makePlanDocument({ plan: { audio: { keepOriginal: true } } }), CTX);
  assert.equal(on.audio.keepOriginal, true);
});

test('без блока audio звук по умолчанию сохраняется', () => {
  const document = makePlanDocument();
  delete document.plan.audio;
  assert.equal(parseRenderPlan(document, CTX).audio.keepOriginal, true);
});

test('поле music принимается ради совместимости, но игнорируется (§0)', () => {
  const document = makePlanDocument();
  document.plan.music = { track: 'energy', volume: 0.9 };

  const plan = parseRenderPlan(document, CTX);
  assert.equal(plan.music, undefined, 'музыка не должна попадать в render spec');
  assert.ok(plan.notes.some((n) => n.startsWith('music-ignored:')));
  // Переключатель звука музыкой не управляется.
  assert.equal(plan.audio.keepOriginal, true);
});

test('music не влияет на keepOriginal даже при keepOriginal: false', () => {
  const document = makePlanDocument({ plan: { audio: { keepOriginal: false } } });
  document.plan.music = { track: 'chill', volume: 0.7 };
  assert.equal(parseRenderPlan(document, CTX).audio.keepOriginal, false);
});

// ── Обратная совместимость с v1 (§0, §7) ──────────────────────────────────

test('план v1 принимается и поднимается до v2', () => {
  const plan = parseRenderPlan(makeV1PlanDocument(), CTX);

  assert.equal(plan.planVersion, 1);
  assert.equal(plan.contractVersion, 2);
  assert.ok(plan.notes.some((n) => n.startsWith('plan-migrated:')));
  assert.equal(plan.clips.length, 2);
});

test('строковые переходы v1 мигрируют в объекты v2', () => {
  const plan = parseRenderPlan(makeV1PlanDocument(), CTX);

  assert.deepEqual(plan.clips[0].transition, {
    type: 'cut',
    durationSeconds: null,
    intensity: 'balanced',
  });
  assert.equal(plan.clips[1].transition.type, 'crossfade');
});

test('план v1 с музыкой даёт keepOriginal: true и пометку', () => {
  const plan = parseRenderPlan(makeV1PlanDocument(), CTX);
  assert.equal(plan.audio.keepOriginal, true);
  assert.ok(plan.notes.some((n) => n.startsWith('music-ignored:')));
});

test('план v1 без textOverlays получает пустой список', () => {
  const plan = parseRenderPlan(makeV1PlanDocument(), CTX);
  assert.deepEqual(plan.textOverlays, []);
});

test('план v1 без fontId получает шрифт по умолчанию', () => {
  const plan = parseRenderPlan(makeV1PlanDocument(), CTX);
  assert.equal(plan.captions.fontId, 'inter');
  assert.equal(plan.captions.position, 'bottom');
});

test('sampleText из v1 сохраняется, cues остаются пустыми', () => {
  const plan = parseRenderPlan(makeV1PlanDocument(), CTX);
  assert.equal(plan.captions.sampleText, 'Лучшие моменты поездки на море');
  assert.deepEqual(plan.captions.cues, []);
});

test('версия контракта вне 1 и 2 отклоняется', () => {
  expectFailure(makePlanDocument({ contractVersion: 3 }), 'CONTRACT_VERSION_UNSUPPORTED');
});

// ── Экспорт (§8) ──────────────────────────────────────────────────────────

test('пресет Instagram Reels перекрывает разрешение и кадры', () => {
  const plan = parseRenderPlan(
    makePlanDocument({ export: { preset: 'instagramReels', resolution: 'hd720', fps: 60 } }),
    CTX,
  );

  assert.equal(plan.export.preset, 'instagramReels');
  assert.equal(plan.export.resolution, 'fullHd1080');
  assert.equal(plan.export.width, 1080);
  assert.equal(plan.export.height, 1920);
  assert.equal(plan.export.fps, 30);
});

test('неизвестный пресет отклоняется', () => {
  expectFailure(makePlanDocument({ export: { preset: 'tiktok' } }), 'RESOLUTION_UNSUPPORTED');
});

test('maximumAvailable отклоняется: §1 резолвит его только backend', () => {
  expectFailure(
    makePlanDocument({ export: { resolution: 'maximumAvailable' } }),
    'RESOLUTION_UNSUPPORTED',
  );
});

test('ширина и высота берутся из таблицы §1, а не из запроса', () => {
  const plan = parseRenderPlan(
    makePlanDocument({ export: { resolution: 'fullHd1080', width: 42, height: 7 } }),
    CTX,
  );
  assert.equal(plan.export.width, 1080);
  assert.equal(plan.export.height, 1920);
});

// ── Субтитры (§6) ─────────────────────────────────────────────────────────

test('стиль minimal принимается наравне с остальными', () => {
  for (const style of ['clean', 'bold', 'karaoke', 'minimal']) {
    const plan = parseRenderPlan(makePlanDocument({ plan: { captions: { style } } }), CTX);
    assert.equal(plan.captions.style, style);
  }
});

test('распознанные реплики сортируются и чистятся от пустых', () => {
  const plan = parseRenderPlan(
    makePlanDocument({
      plan: {
        captions: {
          cues: [
            { start: 3, end: 5, text: 'вторая' },
            { start: 0, end: 2, text: 'первая', words: [{ start: 0, end: 1, text: 'первая', highlight: true }] },
            { start: 6, end: 6, text: 'нулевой длины' },
            { start: 8, end: 9, text: '   ' },
          ],
        },
      },
    }),
    CTX,
  );

  assert.deepEqual(plan.captions.cues.map((c) => c.text), ['первая', 'вторая']);
  assert.equal(plan.captions.cues[0].words[0].highlight, true);
});

test('неизвестный шрифт субтитров откатывается к умолчанию с пометкой', () => {
  const plan = parseRenderPlan(makePlanDocument({ plan: { captions: { fontId: 'wingdings' } } }), CTX);
  assert.equal(plan.captions.fontId, 'inter');
  assert.ok(plan.notes.some((n) => n.startsWith('font-fallback:')));
});

test('некорректный цвет выделения отклоняется', () => {
  expectFailure(
    makePlanDocument({ plan: { captions: { highlightColorHex: 'фиолетовый' } } }),
    'PLAN_INVALID',
  );
});

// ── Текстовые слои (§4) ───────────────────────────────────────────────────

test('textOverlays проходят структурную проверку и передаются дальше', () => {
  const plan = parseRenderPlan(
    makePlanDocument({
      plan: { textOverlays: [{ id: 't1', text: 'Привет', startSeconds: 1, endSeconds: 3 }] },
    }),
    CTX,
  );
  assert.equal(plan.textOverlays.length, 1);
  assert.equal(plan.textOverlays[0].text, 'Привет');
});

test('слишком много текстовых слоёв отклоняется', () => {
  const many = Array.from({ length: 21 }, (_, i) => ({ text: `t${i}` }));
  expectFailure(makePlanDocument({ plan: { textOverlays: many } }), 'PLAN_INVALID');
});

test('textOverlays не массив — ошибка', () => {
  expectFailure(makePlanDocument({ plan: { textOverlays: { text: 'нет' } } }), 'PLAN_INVALID');
});

// ── Инварианты, унаследованные из v1 ──────────────────────────────────────

test('ссылка на неизвестный материал даёт ASSET_MISSING', () => {
  const document = makePlanDocument();
  document.plan.clips[1].mediaId = 'asset_missing';
  expectFailure(document, 'ASSET_MISSING');
});

test('путь вне префикса проекта отклоняется', () => {
  const document = makePlanDocument();
  document.assets[0].objectPath = 'projects/other_project/sources/asset_a.mp4';
  expectFailure(document, 'INVALID_OBJECT_PATH');

  const traversal = makePlanDocument();
  traversal.assets[0].objectPath = 'projects/proj_test/../../etc/passwd';
  expectFailure(traversal, 'INVALID_OBJECT_PATH');
});

test('превышение потолка 120 с даёт DURATION_EXCEEDED', () => {
  const document = makePlanDocument();
  document.plan.clips[0].duration = 100;
  document.plan.clips[0].end = 100.5;
  document.assets[0].durationSeconds = 200;
  document.plan.clips[1].duration = 30;
  expectFailure(document, 'DURATION_EXCEEDED');
});

test('недопустимый переход отклоняется', () => {
  const document = makePlanDocument();
  document.plan.clips[1].transition = { type: 'взрыв' };
  expectFailure(document, 'PLAN_INVALID');
});

test('недопустимая длительность перехода отклоняется', () => {
  const document = makePlanDocument();
  document.plan.clips[1].transition = { type: 'dissolve', durationSeconds: 9 };
  expectFailure(document, 'PLAN_INVALID');
});

test('неизвестные поля игнорируются, а не ломают разбор (§0)', () => {
  const document = makePlanDocument();
  document.futureField = { anything: true };
  document.plan.clips[0].newParam = 42;
  assert.equal(parseRenderPlan(document, CTX).clips.length, 2);
});

test('неиспользуемые материалы не попадают в список загрузки', () => {
  const document = makePlanDocument();
  document.assets.push({
    id: 'asset_unused',
    type: 'video',
    objectPath: 'projects/proj_test/sources/asset_unused.mp4',
    durationSeconds: 10,
  });
  assert.equal(parseRenderPlan(document, CTX).assets.length, 2);
});
