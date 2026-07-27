import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseRenderPlan } from '../../src/plan.js';
import { makePlanDocument } from '../helpers/fixtures.js';

const CTX = { jobId: 'job_TEST0001', projectId: 'proj_test', contractVersion: 1 };

function expectFailure(document, code, ctx = CTX) {
  assert.throws(
    () => parseRenderPlan(document, ctx),
    (err) => {
      assert.equal(err.code, code, `ожидался код ${code}, получен ${err.code}: ${err.message}`);
      return true;
    },
  );
}

test('валидный план разбирается в render spec', () => {
  const plan = parseRenderPlan(makePlanDocument(), CTX);
  assert.equal(plan.planId, 'plan_test_1');
  assert.equal(plan.clips.length, 2);
  assert.equal(plan.assets.length, 2);
  assert.equal(plan.export.width, 720);
  assert.equal(plan.export.height, 1280);
  assert.equal(plan.totalDuration, 6);
  assert.equal(plan.coverClipId, 'clip_1');
});

test('§2.7: filePath клиента не попадает в render spec', () => {
  const plan = parseRenderPlan(makePlanDocument(), CTX);
  for (const clip of plan.clips) {
    assert.equal(clip.filePath, undefined, 'локальный путь клиента должен быть отброшен');
  }
});

test('ширина и высота берутся из таблицы §1, а не из запроса', () => {
  // Клиент прислал заведомо неверный кадр — доверять ему нельзя.
  const document = makePlanDocument({ export: { resolution: 'fullHd1080', width: 42, height: 7 } });
  const plan = parseRenderPlan(document, CTX);
  assert.equal(plan.export.width, 1080);
  assert.equal(plan.export.height, 1920);
  assert.equal(plan.export.videoBitrateKbps, 8000);
  assert.equal(plan.export.level, '4.2');
});

test('maximumAvailable отклоняется: §1 резолвит его только backend', () => {
  expectFailure(
    makePlanDocument({ export: { resolution: 'maximumAvailable' } }),
    'RESOLUTION_UNSUPPORTED',
  );
});

test('неизвестное разрешение отклоняется', () => {
  expectFailure(makePlanDocument({ export: { resolution: 'eightK' } }), 'RESOLUTION_UNSUPPORTED');
});

test('недопустимая частота кадров отклоняется', () => {
  expectFailure(makePlanDocument({ export: { fps: 24 } }), 'PLAN_INVALID');
});

test('ссылка на неизвестный материал даёт ASSET_MISSING', () => {
  const document = makePlanDocument();
  document.plan.clips[1].mediaId = 'asset_missing';
  expectFailure(document, 'ASSET_MISSING');
});

test('путь вне projects/{projectId}/ отклоняется как traversal', () => {
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

test('обрезка за пределами исходника отклоняется', () => {
  const document = makePlanDocument();
  document.plan.clips[0].end = 999;
  expectFailure(document, 'PLAN_INVALID');
});

test('слишком короткая обрезка (< 0.1 с) отклоняется', () => {
  const document = makePlanDocument();
  document.plan.clips[0].start = 1;
  document.plan.clips[0].end = 1.05;
  expectFailure(document, 'PLAN_INVALID');
});

test('чужая версия контракта отклоняется', () => {
  expectFailure(makePlanDocument({ contractVersion: 2 }), 'CONTRACT_VERSION_UNSUPPORTED');
});

test('план от другого проекта отклоняется', () => {
  expectFailure(makePlanDocument({ projectId: 'proj_other' }), 'PLAN_INVALID');
});

test('план от другой задачи отклоняется', () => {
  expectFailure(makePlanDocument({ jobId: 'job_OTHER' }), 'PLAN_INVALID');
});

test('недопустимый цвет субтитров отклоняется', () => {
  expectFailure(
    makePlanDocument({ plan: { captions: { colorHex: 'красный' } } }),
    'PLAN_INVALID',
  );
});

test('громкость музыки вне 0..1 отклоняется', () => {
  expectFailure(makePlanDocument({ plan: { music: { volume: 1.5 } } }), 'PLAN_INVALID');
});

test('фото не требует start/end', () => {
  const document = makePlanDocument();
  document.assets[1] = {
    id: 'asset_b',
    type: 'photo',
    objectPath: 'projects/proj_test/sources/asset_b.jpg',
    width: 800,
    height: 600,
  };
  document.plan.clips[1] = {
    id: 'clip_2',
    mediaId: 'asset_b',
    type: 'photo',
    duration: 2.5,
    transition: 'fade',
  };

  const plan = parseRenderPlan(document, CTX);
  assert.equal(plan.clips[1].type, 'photo');
  assert.equal(plan.clips[1].start, null);
  assert.equal(plan.clips[1].end, null);
  assert.equal(plan.clips[1].duration, 2.5);
});

test('переходы-расширения (dissolve, zoom) принимаются наравне с контрактными', () => {
  for (const transition of ['cut', 'fade', 'crossfade', 'slide', 'dissolve', 'zoom']) {
    const document = makePlanDocument();
    document.plan.clips[1].transition = transition;
    const plan = parseRenderPlan(document, CTX);
    assert.equal(plan.clips[1].transition, transition);
  }
});

test('неизвестный переход отклоняется', () => {
  const document = makePlanDocument();
  document.plan.clips[1].transition = 'explode';
  expectFailure(document, 'PLAN_INVALID');
});

test('неиспользуемые материалы не попадают в список загрузки', () => {
  const document = makePlanDocument();
  document.assets.push({
    id: 'asset_unused',
    type: 'video',
    objectPath: 'projects/proj_test/sources/asset_unused.mp4',
    durationSeconds: 10,
  });
  const plan = parseRenderPlan(document, CTX);
  assert.equal(plan.assets.length, 2);
  assert.ok(!plan.assets.some((a) => a.id === 'asset_unused'));
});

test('дублирующиеся идентификаторы клипов отклоняются', () => {
  const document = makePlanDocument();
  document.plan.clips[1].id = 'clip_1';
  expectFailure(document, 'PLAN_INVALID');
});

test('обложка на несуществующий клип отклоняется', () => {
  expectFailure(makePlanDocument({ plan: { coverClipId: 'clip_404' } }), 'PLAN_INVALID');
});

test('план без клипов отклоняется', () => {
  const document = makePlanDocument();
  document.plan.clips = [];
  expectFailure(document, 'PLAN_INVALID');
});

test('«плоский» план без обёртки тоже принимается (§0 совместимость)', () => {
  const document = makePlanDocument();
  const flat = { ...document.plan, assets: document.assets, export: document.export };
  const plan = parseRenderPlan(flat, CTX);
  assert.equal(plan.planId, 'plan_test_1');
  assert.equal(plan.clips.length, 2);
});

test('неизвестные поля игнорируются, а не ломают разбор (§0)', () => {
  const document = makePlanDocument();
  document.futureField = { anything: true };
  document.plan.clips[0].newTransitionParam = 42;
  const plan = parseRenderPlan(document, CTX);
  assert.equal(plan.clips.length, 2);
});

test('план с uid-схемой принимается, когда backend передал префикс', () => {
  // Схема путей задаётся backend'ом и содержит проверенный uid владельца.
  // Worker обязан принимать её как есть, а не сверять с собственной догадкой.
  const prefix = 'users/uid123/projects/proj_test/';
  const doc = makePlanDocument();
  for (const asset of doc.assets) {
    asset.objectPath = `${prefix}sources/${asset.id}.mp4`;
  }

  const parsed = parseRenderPlan(doc, {
    jobId: 'job_TEST0001',
    projectId: 'proj_test',
    projectPrefix: prefix,
    contractVersion: 1,
  });

  assert.ok(parsed.assets.length > 0);
  for (const asset of parsed.assets) {
    assert.ok(asset.objectPath.startsWith(prefix), `путь вне префикса: ${asset.objectPath}`);
  }
});

test('без переданного префикса действует старая схема', () => {
  // Обратная совместимость: worker обновляется независимо от backend'а.
  const doc = makePlanDocument();
  const parsed = parseRenderPlan(doc, {
    jobId: 'job_TEST0001',
    projectId: 'proj_test',
    contractVersion: 1,
  });
  for (const asset of parsed.assets) {
    assert.ok(asset.objectPath.startsWith('projects/proj_test/'));
  }
});

test('путь чужого владельца отвергается', () => {
  const prefix = 'users/uid123/projects/proj_test/';
  const doc = makePlanDocument();
  doc.assets[0].objectPath = 'users/OTHER/projects/proj_test/sources/a.mp4';

  assert.throws(() =>
    parseRenderPlan(doc, {
      jobId: 'job_TEST0001',
      projectId: 'proj_test',
      projectPrefix: prefix,
      contractVersion: 1,
    }),
  );
});
