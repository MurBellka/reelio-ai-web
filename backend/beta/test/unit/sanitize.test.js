import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  UnsafeModelOutputError,
  assertNoCommandLikeStrings,
  clampNumber,
  parseModelJson,
  pickEnum,
  pickKnownId,
  safeColor,
  safeText,
} from '../../src/sanitize.js';

// ── Числа и перечисления ──────────────────────────────────────────────────

test('число зажимается в диапазон, мусор заменяется fallback', () => {
  assert.equal(clampNumber(5, 0, 1, 0.5), 1);
  assert.equal(clampNumber(-3, 0, 1, 0.5), 0);
  assert.equal(clampNumber('0.7', 0, 1, 0.5), 0.7);
  assert.equal(clampNumber('быстро', 0, 1, 0.5), 0.5);
  assert.equal(clampNumber(NaN, 0, 1, 0.5), 0.5);
  assert.equal(clampNumber(Infinity, 0, 1, 0.5), 0.5);
  assert.equal(clampNumber(null, 0, 1, 0.5), 0.5);
});

test('значение вне перечисления не подменяется «похожим»', () => {
  assert.equal(pickEnum('fade', ['fade', 'cut'], 'cut'), 'fade');
  assert.equal(pickEnum('FADE', ['fade', 'cut'], 'cut'), 'cut');
  assert.equal(pickEnum('fade ', ['fade', 'cut'], 'cut'), 'cut');
  assert.equal(pickEnum(undefined, ['fade'], null), null);
});

test('идентификатор принимается только из серверного списка', () => {
  const known = new Set(['clip_1', 'clip_2']);
  assert.equal(pickKnownId('clip_1', known), 'clip_1');
  assert.equal(pickKnownId('clip_99', known), null);
  assert.equal(pickKnownId('../../etc/passwd', known), null);
  assert.equal(pickKnownId(42, known), null);
});

test('цвет принимается только в формате #RRGGBB', () => {
  assert.equal(safeColor('#a855f7'), '#A855F7');
  assert.equal(safeColor('red', '#000000'), '#000000');
  assert.equal(safeColor('#FFF', '#000000'), '#000000');
  assert.equal(safeColor('#FFFFFF; drawtext', '#000000'), '#000000');
});

// ── Свободный текст (§15) ─────────────────────────────────────────────────

test('невидимые символы вырезаются', () => {
  const zeroWidth = String.fromCharCode(0x200b);
  const bidiOverride = String.fromCharCode(0x202e);
  const bom = String.fromCharCode(0xfeff);

  assert.equal(safeText(`При${zeroWidth}вет`), 'Привет');
  assert.equal(safeText(`a${bidiOverride}b`), 'ab');
  assert.equal(safeText(`${bom}Текст`), 'Текст');
});

test('пробелы схлопываются, длина ограничивается', () => {
  assert.equal(safeText('  много   пробелов  '), 'много пробелов');
  assert.equal(safeText('я'.repeat(500), { maxLength: 10 }), 'я'.repeat(10));
});

test('обычная пунктуация в подписи разрешена', () => {
  const text = 'Цена: 1 000 ₽, скидка «50%» — выгодно!';
  assert.equal(safeText(text), text);
});

test('текст, похожий на путь или команду, отвергается', () => {
  const attacks = [
    'gs://bucket/secret.mp4',
    'file:///etc/passwd',
    '../../etc/passwd',
    '$(rm -rf /)',
    '`whoami`',
    'ffmpeg -i in.mp4 out.mp4',
    'subtitles=/etc/shadow',
    'movie=/tmp/x.mp4',
    'concat:a.mp4|b.mp4',
    'drawtext=text=hack',
  ];

  for (const attack of attacks) {
    assert.throws(
      () => safeText(attack),
      (err) => {
        assert.ok(err instanceof UnsafeModelOutputError, attack);
        assert.equal(err.code, 'MODEL_OUTPUT_REJECTED');
        return true;
      },
      `не отвергнуто: ${attack}`,
    );
  }
});

test('пустой текст отвергается, если явно не разрешён', () => {
  assert.throws(() => safeText('   '), UnsafeModelOutputError);
  assert.equal(safeText('   ', { allowEmpty: true }), '');
  assert.equal(safeText(null, { allowEmpty: true }), '');
  assert.throws(() => safeText(null), UnsafeModelOutputError);
});

// ── Последний рубеж ───────────────────────────────────────────────────────

test('структура с путём в служебном поле отвергается', () => {
  assert.throws(
    () => assertNoCommandLikeStrings({ clips: [{ id: 'clip_1', mediaId: 'gs://bucket/a.mp4' }] }),
    (err) => {
      assert.equal(err.code, 'MODEL_OUTPUT_REJECTED');
      assert.match(err.field, /mediaId/);
      return true;
    },
  );
});

test('разделители фильтра в служебном поле отвергаются', () => {
  assert.throws(
    () => assertNoCommandLikeStrings({ transition: { type: 'fade;drawtext=x' } }),
    UnsafeModelOutputError,
  );
  assert.throws(
    () => assertNoCommandLikeStrings({ style: 'bold|hack' }),
    UnsafeModelOutputError,
  );
});

test('свободный текст проверяется мягче — пунктуация в нём законна', () => {
  assert.doesNotThrow(() =>
    assertNoCommandLikeStrings({
      textOverlays: [{ text: 'Цена: 500 ₽, скидка «50%»' }],
      prompt: 'сделай динамично: быстро, ярко',
    }),
  );
});

test('но и в свободном тексте путь недопустим', () => {
  assert.throws(
    () => assertNoCommandLikeStrings({ text: 'gs://bucket/x' }),
    UnsafeModelOutputError,
  );
});

test('вложенные массивы и объекты обходятся целиком', () => {
  assert.throws(
    () => assertNoCommandLikeStrings({ a: [{ b: [{ c: 'file:///etc/passwd' }] }] }),
    (err) => {
      assert.match(err.field, /a\[0\]\.b\[0\]\.c/);
      return true;
    },
  );
});

// ── Разбор ответа модели (§7) ─────────────────────────────────────────────

test('чистый JSON разбирается', () => {
  assert.deepEqual(parseModelJson('{"a":1}'), { a: 1 });
});

test('JSON в markdown-обёртке разбирается', () => {
  assert.deepEqual(parseModelJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseModelJson('```\n{"a":2}\n```'), { a: 2 });
});

test('JSON с текстом вокруг разбирается', () => {
  assert.deepEqual(parseModelJson('Вот результат: {"a":3} — готово'), { a: 3 });
});

test('массив верхнего уровня не принимается — схема требует объект', () => {
  assert.throws(() => parseModelJson('[1,2,3]'), UnsafeModelOutputError);
});

test('мусор вместо JSON отвергается, а не «чинится»', () => {
  for (const garbage of ['', '   ', 'извините, не могу', '{неполный', 'null', 'undefined']) {
    assert.throws(() => parseModelJson(garbage), UnsafeModelOutputError, `не отвергнуто: ${garbage}`);
  }
});

test('ошибка разбора помечена как повторяемая', () => {
  try {
    parseModelJson('мусор');
    assert.fail('должно было бросить');
  } catch (err) {
    assert.equal(err.retryable, true);
  }
});
