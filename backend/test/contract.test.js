// Юнит-тесты контракта: валидация, разрешения, пути, идемпотентность.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_DURATION_SECONDS,
  assertObjectPath,
  buildFingerprint,
  canTransition,
  canonicalJson,
  estimateSizeBytes,
  newId,
  outputVideoPath,
  planPath,
  progressFor,
  resolveExport,
  validateRenderRequest,
} from '../src/contract.js';
import { ApiError } from '../src/errors.js';

const PROJECT = 'proj_test';

function request(overrides = {}) {
  const projectId = overrides.projectId || PROJECT;
  return {
    contractVersion: 1,
    projectId,
    assets: [
      {
        id: 'asset_a',
        type: 'video',
        objectPath: `projects/${projectId}/sources/asset_a.mp4`,
        durationSeconds: 40,
        width: 1080,
        height: 1920,
      },
      {
        id: 'asset_b',
        type: 'photo',
        objectPath: `projects/${projectId}/sources/asset_b.jpg`,
        width: 2160,
        height: 3840,
      },
    ],
    plan: {
      id: 'plan_1',
      prompt: 'динамичный ролик',
      style: 'dynamicStyle',
      durationSeconds: 10,
      captions: { enabled: true, language: 'ru', style: 'bold', colorHex: '#ffffff' },
      music: { track: 'chill', volume: 0.7 },
      clips: [
        { id: 'clip_1', mediaId: 'asset_a', type: 'video', duration: 4, start: 2, end: 6, transition: 'cut' },
        { id: 'clip_2', mediaId: 'asset_b', type: 'photo', duration: 3, transition: 'fade' },
      ],
    },
    ...overrides,
  };
}

function expectApiError(code, fn) {
  let caught;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof ApiError, `ожидалась ApiError ${code}, исключения не было`);
  assert.equal(caught.code, code, `ожидался код ${code}, получен ${caught.code}`);
  return caught;
}

describe('валидация RenderRequest', () => {
  it('принимает корректный запрос и нормализует поля', () => {
    const v = validateRenderRequest(request());
    assert.equal(v.projectId, PROJECT);
    assert.equal(v.plan.clips.length, 2);
    assert.equal(v.plan.captions.colorHex, '#FFFFFF');
    assert.equal(v.totalDuration, 7);
    // Фото не получает обрезку.
    assert.equal(v.plan.clips[1].start, null);
  });

  it('отвергает чужую версию контракта', () => {
    expectApiError('CONTRACT_VERSION_UNSUPPORTED', () =>
      validateRenderRequest(request({ contractVersion: 2 })),
    );
  });

  it('требует mediaId, известный в assets', () => {
    const body = request();
    body.plan.clips[0].mediaId = 'asset_missing';
    expectApiError('ASSET_MISSING', () => validateRenderRequest(body));
  });

  it('требует mediaId в принципе (filePath не годится)', () => {
    const body = request();
    delete body.plan.clips[0].mediaId;
    body.plan.clips[0].filePath = '/Users/me/video.mp4';
    expectApiError('PLAN_INVALID', () => validateRenderRequest(body));
  });

  it('ловит превышение лимита длительности', () => {
    const body = request();
    body.plan.clips[0].duration = MAX_DURATION_SECONDS;
    body.plan.clips[1].duration = 10;
    expectApiError('DURATION_EXCEEDED', () => validateRenderRequest(body));
  });

  it('ловит обрезку за пределами исходника', () => {
    const body = request();
    body.plan.clips[0].end = 999;
    expectApiError('PLAN_INVALID', () => validateRenderRequest(body));
  });

  it('ловит end <= start', () => {
    const body = request();
    body.plan.clips[0].start = 6;
    body.plan.clips[0].end = 6;
    expectApiError('PLAN_INVALID', () => validateRenderRequest(body));
  });

  it('ловит недопустимый переход и цвет субтитров', () => {
    const bad1 = request();
    bad1.plan.clips[0].transition = 'zoom';
    expectApiError('PLAN_INVALID', () => validateRenderRequest(bad1));

    const bad2 = request();
    bad2.plan.captions.colorHex = 'white';
    expectApiError('PLAN_INVALID', () => validateRenderRequest(bad2));
  });

  it('ловит дублирующиеся идентификаторы', () => {
    const body = request();
    body.plan.clips[1].id = 'clip_1';
    expectApiError('PLAN_INVALID', () => validateRenderRequest(body));
  });

  it('игнорирует косметические поля клипа, но сохраняет их значения', () => {
    const body = request();
    body.plan.clips[0].sourceName = 'IMG_0042.mp4';
    body.plan.clips[0].reason = 'самый динамичный фрагмент';
    const v = validateRenderRequest(body);
    assert.equal(v.plan.clips[0].sourceName, 'IMG_0042.mp4');
    assert.equal(v.plan.clips[0].reason, 'самый динамичный фрагмент');
  });
});

describe('пути Cloud Storage', () => {
  it('строит пути по контракту §6', () => {
    assert.equal(planPath('p1', 'j1'), 'projects/p1/jobs/j1/plan.json');
    assert.equal(outputVideoPath('p1', 'j1', 1920), 'projects/p1/jobs/j1/output/reel_1920p.mp4');
  });

  it('блокирует traversal, чужие проекты и абсолютные пути', () => {
    const cases = [
      `projects/${PROJECT}/../other/x.mp4`,
      'projects/other_project/sources/x.mp4',
      `/projects/${PROJECT}/sources/x.mp4`,
      `gs://bucket/projects/${PROJECT}/sources/x.mp4`,
      `projects/${PROJECT}//sources/x.mp4`,
    ];
    for (const p of cases) {
      expectApiError('INVALID_OBJECT_PATH', () => assertObjectPath(p, PROJECT, 'assets[0].objectPath'));
    }
  });

  it('пропускает валидный путь с дефисом и точкой', () => {
    const p = `projects/${PROJECT}/sources/my-asset.v2.mp4`;
    assert.equal(assertObjectPath(p, PROJECT, 'f'), p);
  });

  it('отклоняет чужой objectPath внутри RenderRequest', () => {
    const body = request();
    body.assets[0].objectPath = 'projects/someone_else/sources/a.mp4';
    expectApiError('INVALID_OBJECT_PATH', () => validateRenderRequest(body));
  });
});

describe('разрешения экспорта', () => {
  it('резолвит maximumAvailable по исходникам, не апскейля', () => {
    const r = resolveExport({
      choice: 'maximumAvailable',
      assets: [{ width: 1080, height: 1920 }],
      durationSeconds: 30,
    });
    assert.equal(r.resolution, 'fullHd1080');
    assert.equal(r.isUpscale, false);
    assert.equal(r.width, 1080);
    assert.equal(r.height, 1920);
  });

  it('для 4K-исходника выбирает 4K', () => {
    const r = resolveExport({ choice: 'maximumAvailable', assets: [{ width: 2160, height: 3840 }] });
    assert.equal(r.resolution, 'fourK2160');
  });

  it('без данных о размерах падает в 1080p', () => {
    assert.equal(resolveExport({ choice: 'maximumAvailable', assets: [] }).resolution, 'fullHd1080');
  });

  it('честно помечает апскейл при явном выборе', () => {
    const r = resolveExport({ choice: 'fourK2160', assets: [{ width: 720, height: 1280 }] });
    assert.equal(r.resolution, 'fourK2160');
    assert.equal(r.isUpscale, true);
  });

  it('покрывает все четыре разрешения контракта', () => {
    const expected = {
      hd720: [720, 1280],
      fullHd1080: [1080, 1920],
      twoK1440: [1440, 2560],
      fourK2160: [2160, 3840],
    };
    for (const [key, [w, h]] of Object.entries(expected)) {
      const r = resolveExport({ choice: key, assets: [], durationSeconds: 30 });
      assert.deepEqual([r.width, r.height], [w, h]);
      assert.ok(r.videoBitrateKbps > 0 && r.audioBitrateKbps > 0);
    }
  });

  it('отвергает неизвестное разрешение и нормализует fps', () => {
    expectApiError('RESOLUTION_UNSUPPORTED', () => resolveExport({ choice: '8k' }));
    assert.equal(resolveExport({ choice: 'hd720', fps: 24 }).fps, 30);
    assert.equal(resolveExport({ choice: 'hd720', fps: 60 }).fps, 60);
  });

  it('оценка размера растёт с разрешением и длительностью', () => {
    const a = estimateSizeBytes({ height: 1280, durationSeconds: 30 });
    const b = estimateSizeBytes({ height: 1920, durationSeconds: 30 });
    const c = estimateSizeBytes({ height: 1920, durationSeconds: 60 });
    assert.ok(a < b && b < c);
  });
});

describe('прогресс и переходы состояний', () => {
  it('этапы дают монотонную шкалу 0..1', () => {
    const seq = ['queued', 'preparing', 'downloading', 'rendering', 'encoding', 'uploading', 'finalizing'];
    let prev = -1;
    for (const phase of seq) {
      const p = progressFor(phase, 1);
      assert.ok(p > prev, `${phase}: ${p} должно быть больше ${prev}`);
      prev = p;
    }
    // finalizing и done оба упираются в 1.0 — это верхняя граница шкалы.
    assert.equal(progressFor('finalizing', 1), 1);
    assert.equal(progressFor('done', 1), 1);
    assert.equal(progressFor('queued', 0), 0);
  });

  it('fraction отображается внутрь диапазона этапа', () => {
    assert.equal(progressFor('encoding', 0), 0.6);
    assert.equal(progressFor('encoding', 0.5), 0.75);
    assert.equal(progressFor('encoding', 1), 0.9);
  });

  it('терминальные состояния необратимы', () => {
    assert.ok(canTransition('queued', 'running'));
    assert.ok(canTransition('running', 'succeeded'));
    for (const terminal of ['succeeded', 'failed', 'cancelled']) {
      for (const to of ['queued', 'running', 'succeeded', 'failed', 'cancelled']) {
        assert.equal(canTransition(terminal, to), false, `${terminal} → ${to}`);
      }
    }
  });
});

describe('идемпотентность', () => {
  it('канонизация не зависит от порядка ключей', () => {
    assert.equal(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] }), canonicalJson({ a: [2, { c: 3, d: 4 }], b: 1 }));
  });

  it('косметические поля клипа не влияют на отпечаток', () => {
    const base = validateRenderRequest(request());
    const withCosmetics = request();
    withCosmetics.plan.clips[0].sourceName = 'другое имя';
    withCosmetics.plan.clips[0].reason = 'другая причина';
    withCosmetics.plan.clips[0].filePath = '/tmp/x.mp4';
    const other = validateRenderRequest(withCosmetics);

    assert.equal(
      buildFingerprint({ ...base }).fingerprint,
      buildFingerprint({ ...other }).fingerprint,
    );
  });

  it('изменение обрезки меняет отпечаток', () => {
    const base = validateRenderRequest(request());
    const changed = request();
    changed.plan.clips[0].end = 5;
    changed.plan.clips[0].duration = 3;
    const other = validateRenderRequest(changed);
    assert.notEqual(buildFingerprint({ ...base }).fingerprint, buildFingerprint({ ...other }).fingerprint);
  });

  it('разные проекты не сталкиваются при одном ключе', () => {
    const a = validateRenderRequest(request());
    const b = validateRenderRequest(request({ projectId: 'proj_other' }));
    assert.notEqual(
      buildFingerprint({ ...a, idempotencyKey: 'k' }).fingerprint,
      buildFingerprint({ ...b, idempotencyKey: 'k' }).fingerprint,
    );
  });

  it('идентификаторы уникальны и безопасны для путей', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId('job')));
    assert.equal(ids.size, 500);
    for (const id of ids) assert.match(id, /^job_[0-9A-Z]{20}$/);
  });
});
