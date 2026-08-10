import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_INTENSITY,
  FALLBACK_TRANSITION,
  INTENSITY_DURATIONS,
  MAX_TRANSITION_SECONDS,
  MIN_TRANSITION_SECONDS,
  TRANSITION_CATALOG,
  V1_TRANSITION_MIGRATION,
  buildVerifiedCatalog,
  canonicalTransition,
  isKnownTransition,
  normalizeTransition,
  resolveTransitionDuration,
} from '../../src/transitions.js';
import { ALL_XFADE_MODES } from '../helpers/fixtures.js';

test('каталог покрывает все группы §2.1', () => {
  const groups = new Set(Object.values(TRANSITION_CATALOG).map((e) => e.group));
  for (const group of ['basic', 'fade', 'wipe', 'slide', 'smooth', 'circle', 'zoom', 'effect']) {
    assert.ok(groups.has(group), `нет группы ${group}`);
  }
});

test('каждый переход, кроме cut, опирается на существующий режим xfade', () => {
  for (const [type, entry] of Object.entries(TRANSITION_CATALOG)) {
    if (type === 'cut') {
      assert.equal(entry.xfade, null, 'cut не должен использовать фильтр');
      continue;
    }
    assert.ok(entry.xfade, `${type}: не задан режим xfade`);
    assert.ok(ALL_XFADE_MODES.has(entry.xfade), `${type}: неизвестный режим ${entry.xfade}`);
  }
});

test('crossfade — синоним dissolve и приводится к нему', () => {
  assert.equal(canonicalTransition('crossfade'), 'dissolve');
  assert.equal(canonicalTransition('dissolve'), 'dissolve');
  assert.equal(
    TRANSITION_CATALOG.crossfade.xfade,
    TRANSITION_CATALOG.dissolve.xfade,
    'синоним обязан давать тот же фильтр',
  );
});

test('неизвестный переход приводится к запасному', () => {
  assert.equal(canonicalTransition('телепортация'), FALLBACK_TRANSITION);
  assert.equal(isKnownTransition('телепортация'), false);
});

test('проверенный каталог — пересечение таблицы и возможностей сборки', () => {
  const catalog = buildVerifiedCatalog(new Set(['fade', 'fadeblack', 'slideleft']));

  assert.ok(catalog.types.includes('cut'), 'cut доступен всегда — он без фильтра');
  assert.ok(catalog.types.includes('dissolve'));
  assert.ok(catalog.types.includes('fadeBlack'));
  assert.ok(catalog.types.includes('slideLeft'));
  assert.ok(!catalog.types.includes('pixelize'), 'недоступный режим не должен попасть в каталог');
  assert.ok(catalog.missing.includes('pixelize'));
});

test('синонимы не дублируются в каталоге для UI', () => {
  const catalog = buildVerifiedCatalog(ALL_XFADE_MODES);
  assert.ok(catalog.types.includes('dissolve'));
  assert.ok(!catalog.types.includes('crossfade'), 'синоним не показывается пользователю отдельно');
});

test('пустой список возможностей не схлопывает каталог до одной склейки', () => {
  // Сборка не отдала справку — доверяем таблице, иначе UI останется без переходов.
  const catalog = buildVerifiedCatalog(new Set());
  assert.ok(catalog.types.length > 10);
  assert.equal(catalog.missing.length, 0);
});

test('полный набор режимов даёт полный каталог', () => {
  const catalog = buildVerifiedCatalog(ALL_XFADE_MODES);
  const canonical = Object.entries(TRANSITION_CATALOG).filter(([, e]) => !e.aliasOf).length;
  assert.equal(catalog.types.length, canonical);
  assert.deepEqual(catalog.missing, []);
});

test('интенсивность задаёт длительность, когда она не указана явно', () => {
  for (const [intensity, expected] of Object.entries(INTENSITY_DURATIONS)) {
    const { seconds } = resolveTransitionDuration({
      intensity,
      prevDuration: 10,
      nextDuration: 10,
    });
    assert.equal(seconds, expected, `интенсивность ${intensity}`);
  }
});

test('явная длительность важнее интенсивности', () => {
  const { seconds } = resolveTransitionDuration({
    requestedSeconds: 1.2,
    intensity: 'dynamic',
    prevDuration: 10,
    nextDuration: 10,
  });
  assert.equal(seconds, 1.2);
});

test('длительность зажимается в 0.15..1.5 с', () => {
  const long = resolveTransitionDuration({ requestedSeconds: 5, prevDuration: 30, nextDuration: 30 });
  assert.equal(long.seconds, MAX_TRANSITION_SECONDS);
  assert.equal(long.clampedBy, 'max');
});

test('переход не длиннее 40% более короткого соседа', () => {
  // 40% от клипа 1 с = 0.4 с, хотя просили 1.5 с.
  const { seconds, clampedBy } = resolveTransitionDuration({
    requestedSeconds: 1.5,
    prevDuration: 10,
    nextDuration: 1,
  });
  assert.equal(seconds, 0.4);
  assert.equal(clampedBy, 'neighbour');
});

test('слишком короткий сосед вырождает переход в стык', () => {
  // 40% от 0.3 с = 0.12 с — меньше минимума 0.15 с.
  const { seconds, clampedBy } = resolveTransitionDuration({
    intensity: 'calm',
    prevDuration: 10,
    nextDuration: 0.3,
  });
  assert.equal(seconds, 0);
  assert.equal(clampedBy, 'degraded-to-cut');
});

test('строка v1 разбирается как переход v2', () => {
  assert.deepEqual(normalizeTransition('crossfade'), {
    type: 'crossfade',
    durationSeconds: null,
    intensity: DEFAULT_INTENSITY,
  });
});

test('все переходы v1 мигрируют в существующие типы v2 (§7)', () => {
  for (const [v1, v2] of Object.entries(V1_TRANSITION_MIGRATION)) {
    assert.ok(isKnownTransition(v2), `${v1} → ${v2}: тип отсутствует в каталоге`);
    const normalized = normalizeTransition(v1);
    assert.equal(normalized.type, v2, `переход ${v1}`);
  }
});

test('v1 fade — это затемнение через чёрный, а не растворение', () => {
  assert.equal(normalizeTransition('fade').type, 'fadeBlack');
  assert.equal(TRANSITION_CATALOG.fadeBlack.xfade, 'fadeblack');
});

test('объект v2 разбирается с длительностью и интенсивностью', () => {
  assert.deepEqual(normalizeTransition({ type: 'wipeLeft', durationSeconds: 0.6, intensity: 'calm' }), {
    type: 'wipeLeft',
    durationSeconds: 0.6,
    intensity: 'calm',
  });
});

test('отсутствие перехода — это стык', () => {
  assert.equal(normalizeTransition(null).type, 'cut');
  assert.equal(normalizeTransition(undefined).type, 'cut');
});

test('неизвестная интенсивность откатывается к сбалансированной', () => {
  assert.equal(normalizeTransition({ type: 'zoomIn', intensity: 'бешеная' }).intensity, DEFAULT_INTENSITY);
});

test('длительность вне допустимого диапазона отвергается', () => {
  assert.equal(normalizeTransition({ type: 'zoomIn', durationSeconds: 9 }), null);
  assert.equal(normalizeTransition({ type: 'zoomIn', durationSeconds: 0.01 }), null);
  assert.equal(normalizeTransition({ type: 'zoomIn', durationSeconds: 'быстро' }), null);
});

test('неизвестный тип отвергается на разборе, а не подменяется молча', () => {
  assert.equal(normalizeTransition({ type: 'взрыв' }), null);
  assert.equal(normalizeTransition('взрыв'), null);
});

test('границы диапазона длительности принимаются', () => {
  for (const seconds of [MIN_TRANSITION_SECONDS, MAX_TRANSITION_SECONDS]) {
    assert.ok(normalizeTransition({ type: 'dissolve', durationSeconds: seconds }));
  }
});
