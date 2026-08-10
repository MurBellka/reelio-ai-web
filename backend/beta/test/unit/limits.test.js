import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ANALYSIS_LIMITS,
  COST_LIMITS,
  CostBudget,
  LimitExceededError,
  PROJECT_LIMITS,
  assertProjectWithinLimits,
  estimateCostUsd,
  framesForDuration,
} from '../../src/limits.js';

// ── §10: состав проекта ───────────────────────────────────────────────────

test('§10: лимиты проекта совпадают с заданием', () => {
  assert.equal(PROJECT_LIMITS.maxVideos, 20);
  assert.equal(PROJECT_LIMITS.maxPhotos, 20);
  assert.equal(PROJECT_LIMITS.maxVideoDurationSeconds, 600);
  assert.equal(PROJECT_LIMITS.maxOutputDurationSeconds, 120);
});

test('§10: проект в пределах лимитов проходит', () => {
  assert.doesNotThrow(() =>
    assertProjectWithinLimits({ videos: 20, photos: 20, longestVideoSeconds: 600 }),
  );
});

test('§10: превышение любого лимита отклоняется с указанием какого', () => {
  const cases = [
    [{ videos: 21, photos: 0, longestVideoSeconds: 10 }, 'maxVideos'],
    [{ videos: 0, photos: 21, longestVideoSeconds: 10 }, 'maxPhotos'],
    [{ videos: 1, photos: 0, longestVideoSeconds: 601 }, 'maxVideoDurationSeconds'],
  ];

  for (const [project, limit] of cases) {
    assert.throws(
      () => assertProjectWithinLimits(project),
      (err) => {
        assert.ok(err instanceof LimitExceededError);
        assert.equal(err.limit, limit);
        assert.equal(err.code, 'LIMIT_EXCEEDED');
        assert.equal(err.retryable, false, 'повтор не поможет — лимит есть лимит');
        return true;
      },
    );
  }
});

// ── §11: выборка кадров ───────────────────────────────────────────────────

test('§11: число кадров растёт с длиной, но упирается в лимит', () => {
  assert.equal(framesForDuration(2), 1);
  assert.equal(framesForDuration(10), 5);
  assert.equal(framesForDuration(600), ANALYSIS_LIMITS.maxFramesPerVideo);
  // Короткое видео всё равно даёт хотя бы один кадр.
  assert.equal(framesForDuration(0.5), 1);
  assert.equal(framesForDuration(0), 1);
});

// ── §11: стоимость ────────────────────────────────────────────────────────

test('оценка стоимости растёт с объёмом и никогда не отрицательна', () => {
  assert.equal(estimateCostUsd({}), 0);
  assert.ok(estimateCostUsd({ frames: 12 }) > 0);
  assert.ok(estimateCostUsd({ frames: 24 }) > estimateCostUsd({ frames: 12 }));
  assert.ok(estimateCostUsd({ audioSeconds: 120 }) > 0);
  assert.equal(estimateCostUsd({ frames: -5 }), 0);
});

test('оценка стоимости анализа одного видео остаётся копеечной', () => {
  // 12 кадров + 120 с аудио + ответ — типичный анализ одного видео.
  const usd = estimateCostUsd({
    frames: ANALYSIS_LIMITS.maxFramesPerVideo,
    audioSeconds: ANALYSIS_LIMITS.maxAudioSecondsPerVideo,
    promptTokens: 1500,
    outputTokens: 1200,
  });
  assert.ok(usd < 0.01, `анализ одного видео стоит ${usd} USD`);
});

test('полный проект по максимуму укладывается в бюджет', () => {
  const usd = estimateCostUsd({
    frames: ANALYSIS_LIMITS.maxFramesPerProject,
    audioSeconds: ANALYSIS_LIMITS.maxAudioSecondsPerProject,
    promptTokens: 40 * 1500,
    outputTokens: 40 * 1200,
  });
  assert.ok(usd < COST_LIMITS.maxProjectUsd, `проект стоит ${usd} при лимите ${COST_LIMITS.maxProjectUsd}`);
});

// ── §11: бюджет проекта ───────────────────────────────────────────────────

test('бюджет списывает расход и накапливает его', () => {
  const budget = new CostBudget();
  const first = budget.charge({ frames: 10, audioSeconds: 60 });

  assert.ok(first.usd > 0);
  assert.equal(budget.calls, 1);
  assert.equal(budget.frames, 10);
  assert.equal(budget.audioSeconds, 60);
  assert.equal(budget.usd, first.totalUsd);

  budget.charge({ frames: 5 });
  assert.equal(budget.calls, 2);
  assert.equal(budget.frames, 15);
});

test('canAfford не списывает и предсказывает отказ', () => {
  const budget = new CostBudget({ maxFrames: 10 });
  assert.equal(budget.canAfford({ frames: 10 }), true);
  assert.equal(budget.canAfford({ frames: 11 }), false);
  assert.equal(budget.frames, 0, 'проверка не должна ничего списывать');
});

test('превышение лимита кадров останавливает анализ', () => {
  const budget = new CostBudget({ maxFrames: 10 });
  budget.charge({ frames: 10 });

  assert.throws(
    () => budget.charge({ frames: 1 }),
    (err) => {
      assert.equal(err.limit, 'maxFramesPerProject');
      return true;
    },
  );
});

test('превышение лимита аудио останавливает анализ', () => {
  const budget = new CostBudget({ maxAudioSeconds: 100 });
  budget.charge({ audioSeconds: 100 });
  assert.throws(() => budget.charge({ audioSeconds: 1 }), LimitExceededError);
});

test('превышение числа вызовов останавливает анализ', () => {
  const budget = new CostBudget({ maxCalls: 2 });
  budget.charge({ frames: 1 });
  budget.charge({ frames: 1 });

  assert.throws(
    () => budget.charge({ frames: 1 }),
    (err) => {
      assert.equal(err.limit, 'maxGeminiCallsPerProject');
      return true;
    },
  );
});

test('денежный потолок срабатывает раньше остальных при дорогом вызове', () => {
  const budget = new CostBudget({ maxUsd: 0.0001, maxFrames: 10_000 });
  assert.throws(
    () => budget.charge({ frames: 5000 }),
    (err) => {
      assert.equal(err.limit, 'maxProjectUsd');
      return true;
    },
  );
  assert.equal(budget.calls, 0, 'неудавшийся вызов не должен списываться');
});

test('снимок бюджета годится для лога и отчёта', () => {
  const budget = new CostBudget();
  budget.charge({ frames: 12, audioSeconds: 60, promptTokens: 1000, outputTokens: 500 });
  const snapshot = budget.snapshot();

  assert.equal(snapshot.calls, 1);
  assert.equal(snapshot.frames, 12);
  assert.ok(snapshot.usd > 0);
  assert.equal(snapshot.maxUsd, COST_LIMITS.maxProjectUsd);
});

test('лимит на проект строже, чем сумма лимитов на видео', () => {
  // Иначе 20 видео по 12 кадров дали бы 240 кадров и неожиданный счёт.
  assert.ok(
    ANALYSIS_LIMITS.maxFramesPerProject <
      PROJECT_LIMITS.maxVideos * ANALYSIS_LIMITS.maxFramesPerVideo,
  );
  assert.ok(
    ANALYSIS_LIMITS.maxAudioSecondsPerProject <
      PROJECT_LIMITS.maxVideos * ANALYSIS_LIMITS.maxAudioSecondsPerVideo,
  );
});
