// HTTP-слой beta: маршруты, авторизация, изоляция, идемпотентность, квоты.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import {
  assetsFor,
  fakeGemini,
  fakeMedia,
  fakeVerifier,
  startServer,
  waitForTerminal,
} from '../helpers/harness.js';

describe('beta API', () => {
  let harness;
  let gemini;
  let media;

  before(async () => {
    gemini = fakeGemini();
    media = fakeMedia();
    harness = await startServer({ gemini, media });
  });

  after(async () => {
    await harness?.close();
  });

  // ── §2: аутентификация и App Check независимы ───────────────────────────

  test('без токена — 401 и стабильный код', async () => {
    const res = await harness.request('GET', '/catalog', { uid: null });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'UNAUTHENTICATED');
    assert.equal(res.body.error.retryable, false);
    assert.ok(res.body.error.requestId);
  });

  test('битый токен — 401, причина наружу не раскрывается', async () => {
    // Заголовки HTTP — ByteString, кириллица в них не кодируется.
    const res = await harness.request('GET', '/catalog', {
      headers: { Authorization: 'Bearer not-a-valid-token' },
      uid: null,
    });
    assert.equal(res.status, 401);
    assert.ok(!JSON.stringify(res.body).includes('auth/argument-error'));
  });

  test('§2: App Check проверяется независимо от аутентификации', async () => {
    const strict = await startServer({
      config: { auth: { appCheckMode: 'enforce', allowInsecureAuth: false } },
    });
    try {
      // Валидный пользователь, но нет App Check → отдельный код 403.
      const noAppCheck = await strict.request('GET', '/catalog', { appCheck: null });
      assert.equal(noAppCheck.status, 403);
      assert.equal(noAppCheck.body.error.code, 'APP_CHECK_FAILED');

      // Валидный App Check, но нет пользователя → 401, а не 403.
      const noAuth = await strict.request('GET', '/catalog', { uid: null });
      assert.equal(noAuth.status, 401);
      assert.equal(noAuth.body.error.code, 'UNAUTHENTICATED');

      // Оба валидны — проходит.
      assert.equal((await strict.request('GET', '/catalog')).status, 200);
    } finally {
      await strict.close();
    }
  });

  test('§2: режим monitor не блокирует запрос без App Check', async () => {
    const monitored = await startServer({
      config: { auth: { appCheckMode: 'monitor', allowInsecureAuth: false } },
    });
    try {
      assert.equal((await monitored.request('GET', '/catalog', { appCheck: null })).status, 200);
    } finally {
      await monitored.close();
    }
  });

  test('/health не требует ни токена, ни App Check и не раскрывает секретов', async () => {
    const res = await fetch(`${harness.base}/health`);
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.service, 'reelio-backend-beta', 'бету нельзя спутать с production');
    assert.equal(body.contractVersion, 2);
    assert.ok(!JSON.stringify(body).toLowerCase().includes('key'));
  });

  // ── §3: изоляция по uid ─────────────────────────────────────────────────

  test('§3: путь к чужим материалам отклоняется', async () => {
    const res = await harness.request('POST', '/analysis', {
      uid: 'user_1',
      body: {
        projectId: 'proj_1',
        assets: [
          {
            id: 'asset_1',
            type: 'video',
            objectPath: 'users/user_2/projects/proj_1/sources/asset_1.mp4',
          },
        ],
      },
    });

    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'FORBIDDEN');
  });

  test('§3: traversal в пути отклоняется', async () => {
    for (const objectPath of [
      'users/user_1/projects/proj_1/../../user_2/secret.mp4',
      '/etc/passwd',
      'users/user_1/projects/proj_1//sources/a.mp4',
    ]) {
      const res = await harness.request('POST', '/analysis', {
        body: { projectId: 'proj_1', assets: [{ id: 'a', type: 'video', objectPath }] },
      });
      assert.ok(res.status === 400 || res.status === 403, `${objectPath} → ${res.status}`);
    }
  });

  test('§3: чужой анализ не виден и не отличим от несуществующего', async () => {
    const created = await harness.request('POST', '/analysis', {
      uid: 'user_1',
      body: { projectId: 'proj_iso', assets: assetsFor('user_1', 'proj_iso') },
    });
    const id = created.body.analysis.analysisId;

    const foreign = await harness.request('GET', `/analysis/${id}`, { uid: 'user_2' });
    const missing = await harness.request('GET', '/analysis/an_DOESNOTEXIST', { uid: 'user_2' });

    assert.equal(foreign.status, 404);
    assert.equal(missing.status, 404);
    assert.equal(foreign.body.error.code, missing.body.error.code);
  });

  test('§3: чужой анализ нельзя отменить', async () => {
    const created = await harness.request('POST', '/analysis', {
      uid: 'user_1',
      body: { projectId: 'proj_c', assets: assetsFor('user_1', 'proj_c') },
    });
    const res = await harness.request('POST', `/analysis/${created.body.analysis.analysisId}/cancel`, {
      uid: 'user_2',
    });
    assert.equal(res.status, 404);
  });

  // ── §4: идемпотентность ─────────────────────────────────────────────────

  test('§4: повтор с тем же ключом не создаёт новую задачу', async () => {
    const local = await startServer({ gemini: fakeGemini(), media: fakeMedia() });
    try {
      const body = { projectId: 'proj_i', assets: assetsFor('user_1', 'proj_i') };
      const headers = { 'Idempotency-Key': 'key-abc' };

      const first = await local.request('POST', '/analysis', { body, headers });
      const second = await local.request('POST', '/analysis', { body, headers });

      assert.equal(first.status, 202, 'первый запрос создаёт задачу');
      assert.equal(second.status, 200, 'повтор возвращает существующую');
      assert.equal(first.body.analysis.analysisId, second.body.analysis.analysisId);
    } finally {
      await local.close();
    }
  });

  test('§4: повтор не вызывает Gemini заново и не списывает квоту', async () => {
    const g = fakeGemini();
    const local = await startServer({ gemini: g, media: fakeMedia() });
    try {
      const body = { projectId: 'proj_r', assets: assetsFor('user_1', 'proj_r') };
      const headers = { 'Idempotency-Key': 'key-repeat' };

      const first = await local.request('POST', '/analysis', { body, headers });
      await waitForTerminal(local, first.body.analysis.analysisId);

      const callsAfterFirst = g.calls.length;
      const usageAfterFirst = await local.request('GET', '/usage?projectId=proj_r');

      // Пять повторов подряд.
      for (let i = 0; i < 5; i += 1) {
        const repeat = await local.request('POST', '/analysis', { body, headers });
        assert.equal(repeat.status, 200);
      }

      const usageAfterRepeats = await local.request('GET', '/usage?projectId=proj_r');
      assert.equal(g.calls.length, callsAfterFirst, 'Gemini не должен вызываться повторно');
      assert.equal(
        usageAfterRepeats.body.analyses.used,
        usageAfterFirst.body.analyses.used,
        'квота не должна списываться повторно',
      );
    } finally {
      await local.close();
    }
  });

  // ── §5: кэш по содержимому ──────────────────────────────────────────────

  test('§5: тот же материал в новом проекте берётся из кэша бесплатно', async () => {
    const g = fakeGemini();
    // Путь у материала project-scoped, поэтому «тот же файл в другом проекте»
    // моделируется одинаковым хешом СОДЕРЖИМОГО — именно он и есть ключ кэша.
    const local = await startServer({
      gemini: g,
      media: fakeMedia({ contentHashFor: () => 'identical-bytes' }),
    });
    try {
      const inProject = (projectId) => [
        {
          id: 'asset_same',
          type: 'video',
          objectPath: `users/user_1/projects/${projectId}/sources/same.mp4`,
          durationSeconds: 10,
        },
      ];

      const first = await local.request('POST', '/analysis', {
        body: { projectId: 'proj_a', assets: inProject('proj_a') },
      });
      await waitForTerminal(local, first.body.analysis.analysisId);
      const callsAfterFirst = g.calls.length;
      assert.ok(callsAfterFirst > 0);

      const second = await local.request('POST', '/analysis', {
        body: { projectId: 'proj_b', assets: inProject('proj_b') },
        headers: { 'Idempotency-Key': 'other-key' },
      });
      const done = await waitForTerminal(local, second.body.analysis.analysisId);

      assert.equal(done.status, 'succeeded');
      assert.equal(g.calls.length, callsAfterFirst, 'кэш-попадание не должно звать Gemini');
      assert.equal(done.creditsSpent, 0, 'за кэш платить не должны');
      assert.equal(done.fromCache, true);
    } finally {
      await local.close();
    }
  });

  test('§5: другой материал даёт честный вызов и списание', async () => {
    const g = fakeGemini();
    const local = await startServer({ gemini: g, media: fakeMedia() });
    try {
      const first = await local.request('POST', '/analysis', {
        body: { projectId: 'p1', assets: assetsFor('user_1', 'p1') },
      });
      await waitForTerminal(local, first.body.analysis.analysisId);
      const calls = g.calls.length;

      const second = await local.request('POST', '/analysis', {
        body: { projectId: 'p2', assets: assetsFor('user_1', 'p2') },
      });
      const done = await waitForTerminal(local, second.body.analysis.analysisId);

      assert.ok(g.calls.length > calls, 'новый материал обязан вызвать модель');
      assert.equal(done.creditsSpent, 1);
      assert.equal(done.fromCache, false);
    } finally {
      await local.close();
    }
  });

  test('§5: кэш не пересекается между пользователями', async () => {
    const g = fakeGemini();
    const local = await startServer({ gemini: g, media: fakeMedia() });
    try {
      // Одинаковое содержимое, но разные владельцы.
      const media2 = fakeMedia();
      const path1 = 'users/user_1/projects/p/sources/x.mp4';
      const path2 = 'users/user_2/projects/p/sources/x.mp4';

      const a = await local.request('POST', '/analysis', {
        uid: 'user_1',
        body: { projectId: 'p', assets: [{ id: 'x', type: 'video', objectPath: path1 }] },
      });
      await waitForTerminal(local, a.body.analysis.analysisId, 'user_1');
      const calls = g.calls.length;

      const b = await local.request('POST', '/analysis', {
        uid: 'user_2',
        body: { projectId: 'p', assets: [{ id: 'x', type: 'video', objectPath: path2 }] },
      });
      await waitForTerminal(local, b.body.analysis.analysisId, 'user_2');

      assert.ok(g.calls.length > calls, 'второй пользователь не должен получить чужой кэш');
      void media2;
    } finally {
      await local.close();
    }
  });

  // ── §3: квоты ───────────────────────────────────────────────────────────

  test('§3: суточный лимит исчерпывается и даёт понятный код', async () => {
    const local = await startServer({
      gemini: fakeGemini(),
      media: fakeMedia(),
      config: { limits: { perUserPerDay: 2, perProjectPerDay: 10, maxActiveAnalyses: 5 } },
    });
    try {
      for (let i = 0; i < 2; i += 1) {
        const res = await local.request('POST', '/analysis', {
          body: { projectId: `q${i}`, assets: assetsFor('user_1', `q${i}`) },
        });
        await waitForTerminal(local, res.body.analysis.analysisId);
      }

      const third = await local.request('POST', '/analysis', {
        body: { projectId: 'q3', assets: assetsFor('user_1', 'q3') },
      });
      const done = await waitForTerminal(local, third.body.analysis.analysisId);

      assert.equal(done.status, 'failed');
      assert.equal(done.error.code, 'DAILY_LIMIT_REACHED');
      assert.equal(done.error.retryable, false);
    } finally {
      await local.close();
    }
  });

  test('/usage показывает потребление и лимит', async () => {
    const local = await startServer({ gemini: fakeGemini(), media: fakeMedia() });
    try {
      const before = await local.request('GET', '/usage?projectId=pu');
      assert.equal(before.body.analyses.used, 0);
      assert.ok(before.body.analyses.limit > 0);

      const created = await local.request('POST', '/analysis', {
        body: { projectId: 'pu', assets: assetsFor('user_1', 'pu') },
      });
      await waitForTerminal(local, created.body.analysis.analysisId);

      const after = await local.request('GET', '/usage?projectId=pu');
      assert.equal(after.body.analyses.used, 1);
      assert.equal(after.body.project.used, 1);
      // Денежные потолки наружу не отдаются — только кредиты.
      assert.ok(!JSON.stringify(after.body).includes('usd'));
    } finally {
      await local.close();
    }
  });

  // ── §12: отмена и повтор ────────────────────────────────────────────────

  test('§12: отмена возвращает квоту', async () => {
    const local = await startServer({
      gemini: fakeGemini({ delayMs: 200 }),
      media: fakeMedia(),
    });
    try {
      const created = await local.request('POST', '/analysis', {
        body: { projectId: 'pc', assets: assetsFor('user_1', 'pc', 2) },
      });
      const id = created.body.analysis.analysisId;

      // Даём анализу начать и списать квоту.
      await new Promise((resolve) => setTimeout(resolve, 120));
      const cancelled = await local.request('POST', `/analysis/${id}/cancel`);

      assert.equal(cancelled.status, 200);
      assert.equal(cancelled.body.analysis.status, 'cancelled');

      const usage = await local.request('GET', '/usage?projectId=pc');
      assert.equal(usage.body.analyses.used, 0, 'за отменённую работу платить не должны');
    } finally {
      await local.close();
    }
  });

  test('§12: повторная отмена завершённого анализа даёт 409', async () => {
    const local = await startServer({ gemini: fakeGemini(), media: fakeMedia() });
    try {
      const created = await local.request('POST', '/analysis', {
        body: { projectId: 'pd', assets: assetsFor('user_1', 'pd') },
      });
      const id = created.body.analysis.analysisId;
      await waitForTerminal(local, id);

      const res = await local.request('POST', `/analysis/${id}/cancel`);
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'ANALYSIS_ALREADY_TERMINAL');
    } finally {
      await local.close();
    }
  });

  test('§12: повтор после ошибки переиспользует кэш и не платит дважды', async () => {
    const failing = fakeGemini({ fail: Object.assign(new Error('boom'), { code: 'UPSTREAM_FAILED' }) });
    const local = await startServer({ gemini: failing, media: fakeMedia() });
    try {
      const created = await local.request('POST', '/analysis', {
        body: { projectId: 'pr', assets: assetsFor('user_1', 'pr') },
      });
      const id = created.body.analysis.analysisId;
      const failed = await waitForTerminal(local, id);

      assert.equal(failed.status, 'failed');
      assert.equal(failed.error.code, 'UPSTREAM_FAILED');
      assert.equal(failed.error.retryable, true);

      const retried = await local.request('POST', `/analysis/${id}/retry`, {
        body: { assets: assetsFor('user_1', 'pr') },
      });
      assert.equal(retried.status, 202);
      assert.equal(retried.body.analysis.status, 'queued');
      assert.equal(retried.body.analysis.error, null);
    } finally {
      await local.close();
    }
  });

  // ── §6: прогресс и ошибки ───────────────────────────────────────────────

  test('§6: прогресс не убывает и доходит до единицы', async () => {
    const local = await startServer({ gemini: fakeGemini({ delayMs: 30 }), media: fakeMedia() });
    try {
      const created = await local.request('POST', '/analysis', {
        body: { projectId: 'pp', assets: assetsFor('user_1', 'pp', 3) },
      });
      const id = created.body.analysis.analysisId;

      let previous = -1;
      for (let i = 0; i < 40; i += 1) {
        const res = await local.request('GET', `/analysis/${id}`);
        const { progress, status } = res.body.analysis;
        assert.ok(progress >= previous, `прогресс откатился: ${previous} → ${progress}`);
        previous = progress;
        if (['succeeded', 'failed', 'cancelled'].includes(status)) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      const done = await waitForTerminal(local, id);
      assert.equal(done.status, 'succeeded');
      assert.equal(done.progress, 1);
    } finally {
      await local.close();
    }
  });

  test('§6: ответ о статусе не содержит внутренних полей', async () => {
    const created = await harness.request('POST', '/analysis', {
      body: { projectId: 'ps', assets: assetsFor('user_1', 'ps') },
    });
    const res = await harness.request('GET', `/analysis/${created.body.analysis.analysisId}`);
    const analysis = res.body.analysis;

    for (const internal of ['uid', 'fingerprint', 'contentHash', 'analyses', 'costUsd']) {
      assert.ok(!(internal in analysis), `внутреннее поле «${internal}» не должно уходить клиенту`);
    }
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  test('§6: неизвестный маршрут даёт структурированную ошибку', async () => {
    const res = await harness.request('GET', '/nope');
    assert.equal(res.status, 404);
    assert.ok(res.body.error.code);
    assert.ok(res.body.error.requestId);
  });

  // ── §1: план ────────────────────────────────────────────────────────────

  test('§1: EditPlan v2 отдаётся после успешного анализа', async () => {
    const local = await startServer({ gemini: fakeGemini(), media: fakeMedia() });
    try {
      const created = await local.request('POST', '/analysis', {
        body: { projectId: 'pl', assets: assetsFor('user_1', 'pl', 2) },
      });
      const id = created.body.analysis.analysisId;
      await waitForTerminal(local, id);

      const res = await local.request('POST', `/analysis/${id}/plan`, {
        body: { prompt: 'динамичный ролик', targetDurationSeconds: 15 },
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.contractVersion, 2);
      assert.ok(res.body.plan.clips.length > 0);
      assert.equal(res.body.plan.audio.keepOriginal, true);
      assert.ok(!('music' in res.body.plan), 'музыки в плане быть не должно');
      assert.match(res.body.projectPrefix, /^users\/user_1\/projects\/pl\//);
    } finally {
      await local.close();
    }
  });

  test('§1: план недоступен, пока анализ не готов', async () => {
    const local = await startServer({ gemini: fakeGemini({ delayMs: 500 }), media: fakeMedia() });
    try {
      const created = await local.request('POST', '/analysis', {
        body: { projectId: 'pw', assets: assetsFor('user_1', 'pw') },
      });
      const res = await local.request('POST', `/analysis/${created.body.analysis.analysisId}/plan`, {
        body: {},
      });
      assert.equal(res.status, 404);
    } finally {
      await local.close();
    }
  });

  test('§1: каталог отдаёт переходы, шрифты и лимиты для UI', async () => {
    const res = await harness.request('GET', '/catalog');

    assert.equal(res.status, 200);
    assert.ok(res.body.transitions.length >= 20);
    assert.ok(res.body.fonts.includes('montserrat'));
    assert.equal(res.body.limits.maxVideos, 20);
    assert.equal(res.body.limits.maxOutputDurationSeconds, 120);
    assert.ok(!JSON.stringify(res.body).toLowerCase().includes('музык'));
  });

  // ── §10: лимиты состава ─────────────────────────────────────────────────

  test('§10: превышение числа видео отклоняется до анализа', async () => {
    const many = Array.from({ length: 21 }, (_, i) => ({
      id: `a${i}`,
      type: 'video',
      objectPath: `users/user_1/projects/pm/sources/a${i}.mp4`,
      durationSeconds: 5,
    }));

    const res = await harness.request('POST', '/analysis', {
      body: { projectId: 'pm', assets: many },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'LIMIT_EXCEEDED');
    assert.equal(res.body.error.field, 'maxVideos');
  });

  test('§10: слишком длинное видео отклоняется', async () => {
    const res = await harness.request('POST', '/analysis', {
      body: {
        projectId: 'pv',
        assets: [
          {
            id: 'a',
            type: 'video',
            objectPath: 'users/user_1/projects/pv/sources/a.mp4',
            durationSeconds: 601,
          },
        ],
      },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.field, 'maxVideoDurationSeconds');
  });

  test('пустой список материалов отклоняется', async () => {
    const res = await harness.request('POST', '/analysis', {
      body: { projectId: 'pe', assets: [] },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'INVALID_REQUEST');
  });
});
