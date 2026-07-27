import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GEMINI_OPERATIONS_SCHEMA, OPERATION_TYPES, normalizeOperations } from '../../src/operations.js';
import { findMusicMention } from '../../src/prompts.js';
import { UnsafeModelOutputError } from '../../src/sanitize.js';

const CTX = {
  clipIds: new Set(['clip_1', 'clip_2', 'clip_3']),
  textIds: new Set(['text_1']),
  maxDuration: 120,
};

const norm = (ops) => normalizeOperations({ operations: ops }, CTX);

// ── Все восемь команд из задания ──────────────────────────────────────────

test('§8: поставить текст в указанное место и время', () => {
  const { operations } = norm([
    {
      op: 'addText',
      text: 'Наша поездка',
      startSeconds: 3,
      endSeconds: 6,
      anchor: 'top',
      x: 0.5,
      y: 0.2,
    },
  ]);

  assert.equal(operations.length, 1);
  assert.deepEqual(
    { op: operations[0].op, text: operations[0].text, start: operations[0].startSeconds },
    { op: 'addText', text: 'Наша поездка', start: 3 },
  );
  assert.equal(operations[0].anchor, 'top');
});

test('§8: выбрать шрифт, цвет и анимацию', () => {
  const { operations } = norm([
    { op: 'styleText', targetId: 'text_1', fontId: 'montserrat', fontWeight: 'bold', colorHex: '#ffffff', animation: 'pop' },
  ]);

  assert.deepEqual(operations[0], {
    op: 'styleText',
    targetId: 'text_1',
    fontId: 'montserrat',
    fontWeight: 'bold',
    colorHex: '#FFFFFF',
    animation: 'pop',
  });
});

test('§8: ускорить начало — обрезать вступление клипа', () => {
  const { operations } = norm([
    { op: 'trimClip', clipId: 'clip_1', startSeconds: 2.5, endSeconds: 5 },
  ]);
  assert.deepEqual(operations[0], {
    op: 'trimClip',
    clipId: 'clip_1',
    startSeconds: 2.5,
    endSeconds: 5,
  });
});

test('§8: убрать фрагмент', () => {
  assert.deepEqual(norm([{ op: 'removeClip', clipId: 'clip_2' }]).operations[0], {
    op: 'removeClip',
    clipId: 'clip_2',
  });
});

test('§8: переставить фрагменты', () => {
  const { operations } = norm([{ op: 'reorderClips', order: ['clip_3', 'clip_1', 'clip_2'] }]);
  assert.deepEqual(operations[0].order, ['clip_3', 'clip_1', 'clip_2']);
});

test('§8: выбрать переход', () => {
  const { operations } = norm([
    { op: 'setTransition', clipId: 'clip_2', transitionType: 'circleOpen', durationSeconds: 0.6, intensity: 'calm' },
  ]);
  assert.deepEqual(operations[0], {
    op: 'setTransition',
    clipId: 'clip_2',
    transitionType: 'circleOpen',
    durationSeconds: 0.6,
    intensity: 'calm',
  });
});

test('§8: сохранить оригинальный звук либо экспортировать без звука', () => {
  assert.equal(norm([{ op: 'setAudio', keepOriginal: true }]).operations[0].keepOriginal, true);
  assert.equal(norm([{ op: 'setAudio', keepOriginal: false }]).operations[0].keepOriginal, false);
});

test('§8: настроить субтитры', () => {
  const { operations } = norm([
    { op: 'setCaptions', enabled: true, style: 'karaoke', position: 'bottom', highlightColorHex: '#a855f7' },
  ]);
  assert.equal(operations[0].style, 'karaoke');
  assert.equal(operations[0].highlightColorHex, '#A855F7');
});

// ── §15: модель не может выйти за перечисления ────────────────────────────

test('§15: ссылка на несуществующий клип отбрасывается с предупреждением', () => {
  const { operations, warnings } = norm([
    { op: 'removeClip', clipId: 'clip_999' },
    { op: 'removeClip', clipId: '../../etc/passwd' },
    { op: 'removeClip', clipId: 'clip_1' },
  ]);

  assert.equal(operations.length, 1, 'выжить должна только настоящая ссылка');
  assert.equal(operations[0].clipId, 'clip_1');
  assert.equal(warnings.length, 2);
});

test('§15: неизвестный переход отбрасывается, а не подменяется', () => {
  const { operations, warnings } = norm([
    { op: 'setTransition', clipId: 'clip_2', transitionType: 'взрыв; drawtext=hack' },
  ]);
  assert.equal(operations.length, 0);
  assert.match(warnings[0], /неизвестный переход/);
});

test('§15: синонимы v1 принимаются и приводятся к каноническим', () => {
  const { operations } = norm([
    { op: 'setTransition', clipId: 'clip_2', transitionType: 'crossfade' },
    { op: 'setTransition', clipId: 'clip_3', transitionType: 'fade' },
  ]);
  assert.equal(operations[0].transitionType, 'dissolve');
  assert.equal(operations[1].transitionType, 'fadeBlack');
});

test('§15: текст-инъекция роняет операцию исключением, а не проходит', () => {
  assert.throws(
    () => norm([{ op: 'addText', text: 'subtitles=/etc/shadow', startSeconds: 0, endSeconds: 2 }]),
    UnsafeModelOutputError,
  );
});

test('§15: неизвестная операция отбрасывается', () => {
  const { operations, warnings } = norm([
    { op: 'runShell', command: 'rm -rf /' },
    { op: 'setAudio', keepOriginal: true },
  ]);
  assert.equal(operations.length, 1);
  assert.match(warnings[0], /неизвестная операция/);
});

test('§15: числа зажимаются в допустимые диапазоны', () => {
  const { operations } = norm([
    {
      op: 'addText',
      text: 'Текст',
      startSeconds: -100,
      endSeconds: 99999,
      x: 5,
      y: -3,
      fontSizeRatio: 10,
    },
  ]);

  const op = operations[0];
  assert.equal(op.startSeconds, 0);
  assert.equal(op.endSeconds, 120);
  assert.equal(op.x, 1);
  assert.equal(op.y, 0);
  assert.equal(op.fontSizeRatio, 0.15);
});

test('§15: неизвестный шрифт не подставляется как строка', () => {
  const { operations } = norm([
    { op: 'addText', text: 'Т', startSeconds: 0, endSeconds: 2, fontId: '../fonts/evil.ttf' },
  ]);
  assert.equal(operations[0].fontId, null, 'неизвестный шрифт заменяется на null, а не на путь');
});

// ── Устойчивость ──────────────────────────────────────────────────────────

test('перестановка с дубликатом отбрасывается — иначе потеряется клип', () => {
  const { operations, warnings } = norm([
    { op: 'reorderClips', order: ['clip_1', 'clip_1', 'clip_2'] },
  ]);
  assert.equal(operations.length, 0);
  assert.match(warnings[0], /повторяющ/);
});

test('setAudio без булева значения отбрасывается', () => {
  const { operations, warnings } = norm([{ op: 'setAudio', keepOriginal: 'да' }]);
  assert.equal(operations.length, 0);
  assert.match(warnings[0], /булев/);
});

test('слишком короткий интервал текста отбрасывается', () => {
  const { operations } = norm([
    { op: 'addText', text: 'Т', startSeconds: 1, endSeconds: 1.05 },
  ]);
  assert.equal(operations.length, 0);
});

test('не-массив операций даёт предупреждение, а не падение', () => {
  const { operations, warnings } = normalizeOperations({ operations: 'ничего' }, CTX);
  assert.deepEqual(operations, []);
  assert.equal(warnings.length, 1);
});

test('лишние операции сверх лимита отбрасываются', () => {
  const many = Array.from({ length: 50 }, () => ({ op: 'setAudio', keepOriginal: true }));
  const { operations, warnings } = norm(many);
  assert.equal(operations.length, 40);
  assert.ok(warnings.some((w) => w.includes('40')));
});

test('одна плохая операция не отменяет остальные', () => {
  const { operations } = norm([
    { op: 'removeClip', clipId: 'нет такого' },
    { op: 'setAudio', keepOriginal: false },
    { op: 'setTransition', clipId: 'clip_2', transitionType: 'zoomIn' },
  ]);
  assert.equal(operations.length, 2);
});

// ── Схема ─────────────────────────────────────────────────────────────────

test('схема операций перечисляет ровно поддерживаемые команды', () => {
  const schemaOps = GEMINI_OPERATIONS_SCHEMA.properties.operations.items.properties.op.enum;
  assert.deepEqual([...schemaOps].sort(), [...OPERATION_TYPES].sort());
});

test('§9: в схеме операций нет ничего про музыку', () => {
  const found = findMusicMention(JSON.stringify(GEMINI_OPERATIONS_SCHEMA));
  assert.equal(found, null, `схема упоминает музыку: «${found}»`);
});

test('§15: в схеме нет полей для путей и имён файлов', () => {
  const fields = Object.keys(GEMINI_OPERATIONS_SCHEMA.properties.operations.items.properties);
  for (const field of fields) {
    assert.ok(
      !/path|file|url|uri|command|filter/i.test(field),
      `поле «${field}» позволило бы модели задать путь или команду`,
    );
  }
});
