import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RESOLUTIONS } from '../../src/contract.js';
import {
  assTimecode,
  buildCues,
  splitIntoChunks,
  srtTimecode,
  toAss,
  toSrt,
  wrapText,
} from '../../src/subtitles.js';

const segments = [
  { start: 0, end: 3 },
  { start: 3, end: 6 },
  { start: 6, end: 10 },
];

const FRAME = { width: 1080, height: 1920 };
const base = { style: 'clean', colorHex: '#FFFFFF', ...FRAME };

test('таймкод SRT — часы:минуты:секунды,миллисекунды', () => {
  assert.equal(srtTimecode(0), '00:00:00,000');
  assert.equal(srtTimecode(3.25), '00:00:03,250');
  assert.equal(srtTimecode(3661.5), '01:01:01,500');
});

test('таймкод ASS — сотые доли без ведущего нуля в часах', () => {
  assert.equal(assTimecode(3.25), '0:00:03.25');
  assert.equal(assTimecode(3661.5), '1:01:01.50');
});

test('перенос не разрывает слова и не теряет текст', () => {
  const lines = wrapText('Лучшие моменты поездки на море', 14);
  assert.equal(lines.join(' '), 'Лучшие моменты поездки на море');
  assert.ok(lines.length >= 2);
});

test('текст делится на части по числу клипов без потерь', () => {
  const chunks = splitIntoChunks('раз два три четыре пять шесть', 3);
  assert.equal(chunks.length, 3);
  assert.equal(chunks.join(' '), 'раз два три четыре пять шесть');
});

// ── Источник реплик (§6.1) ────────────────────────────────────────────────

test('распознанная речь имеет приоритет над sampleText', () => {
  const cues = buildCues({
    captions: {
      enabled: true,
      sampleText: 'игнорируется',
      cues: [
        { start: 2, end: 4, text: 'вторая' },
        { start: 0, end: 1.5, text: 'первая' },
      ],
    },
    segments,
  });

  assert.deepEqual(cues.map((c) => c.text), ['первая', 'вторая']);
});

test('без распознанной речи sampleText раскладывается по клипам', () => {
  const cues = buildCues({
    captions: { enabled: true, sampleText: 'Лучшие моменты поездки на море сегодня', cues: [] },
    segments,
  });

  assert.equal(cues.length, 3);
  cues.forEach((cue, i) => {
    assert.ok(cue.start >= segments[i].start);
    assert.ok(cue.end <= segments[i].end);
  });
});

test('выключенные субтитры не дают реплик', () => {
  assert.deepEqual(buildCues({ captions: { enabled: false, sampleText: 'текст' }, segments }), []);
});

test('SRT нумерует реплики и использует стрелку', () => {
  const srt = toSrt([{ start: 0, end: 2, text: 'Привет, мир' }]);
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:02,000\nПривет, мир\n$/);
});

// ── Стили (§6) ────────────────────────────────────────────────────────────

test('ASS содержит кириллическую кодировку и размер кадра', () => {
  const ass = toAss([{ start: 0, end: 2, text: 'Привет' }], base);
  assert.match(ass, /PlayResX: 1080/);
  assert.match(ass, /PlayResY: 1920/);
  assert.match(ass, /,204$/m, 'Encoding 204 — кириллица');
});

test('все четыре стиля §6 дают валидную строку стиля', () => {
  for (const style of ['clean', 'bold', 'karaoke', 'minimal']) {
    const ass = toAss([{ start: 0, end: 2, text: 'Привет' }], { ...base, style });
    assert.match(ass, /^Style: Reelio,/m, `стиль ${style}`);
    assert.match(ass, /^Dialogue: /m, `стиль ${style}`);
  }
});

test('minimal тоньше и без обводки, bold крупнее и жирнее clean', () => {
  const sizeOf = (style) =>
    Number(/^Style: Reelio,[^,]+,(\d+),/m.exec(toAss([], { ...base, style }))[1]);
  const outlineOf = (style) => {
    const fields = /^Style: Reelio,(.*)$/m.exec(toAss([], { ...base, style }))[1].split(',');
    return Number(fields[15]);
  };

  assert.ok(sizeOf('minimal') < sizeOf('clean'));
  assert.ok(sizeOf('bold') > sizeOf('clean'));
  assert.equal(outlineOf('minimal'), 0, 'у minimal обводки нет');
  assert.ok(outlineOf('bold') > 0);
});

test('шрифт субтитров берётся из каталога §5', () => {
  assert.match(toAss([], { ...base, fontId: 'montserrat' }), /^Style: Reelio,Montserrat,/m);
});

test('неизвестный шрифт откатывается к умолчанию', () => {
  assert.match(toAss([], { ...base, fontId: 'нет-такого' }), /^Style: Reelio,Inter,/m);
});

test('позиция задаёт код выравнивания ASS', () => {
  const codes = { top: 8, center: 5, bottom: 2 };
  for (const [position, code] of Object.entries(codes)) {
    const fields = /^Style: Reelio,(.*)$/m.exec(toAss([], { ...base, position }))[1].split(',');
    assert.equal(Number(fields[17]), code, `позиция ${position}`);
  }
});

// ── Karaoke и выделение слов ──────────────────────────────────────────────

test('karaoke размечает слова тегами \\k с суммой, равной длине реплики', () => {
  const ass = toAss([{ start: 0, end: 3, text: 'раз два три' }], { ...base, style: 'karaoke' });
  const dialogue = /^Dialogue: .*,,(.*)$/m.exec(ass)[1];
  const centis = [...dialogue.matchAll(/\{\\k(\d+)\}/g)].map((m) => Number(m[1]));

  assert.equal(centis.length, 3);
  assert.equal(
    centis.reduce((a, b) => a + b, 0),
    300,
  );
});

test('слова с highlight выделяются цветом, остальные — нет', () => {
  const ass = toAss(
    [
      {
        start: 0,
        end: 3,
        text: 'скидка сегодня только',
        words: [
          { start: 0, end: 1, text: 'скидка', highlight: true },
          { start: 1, end: 2, text: 'сегодня', highlight: false },
        ],
      },
    ],
    { ...base, style: 'bold', highlightColorHex: '#A855F7' },
  );

  const dialogue = /^Dialogue: .*,,(.*)$/m.exec(ass)[1];
  // #A855F7 → BGR F755A8. Инлайновый \c — шесть разрядов и завершающий «&».
  assert.match(dialogue, /\{\\c&HF755A8&\}скидка/, 'выделенное слово получает цвет');
  assert.ok(!/\{\\c[^}]+\}сегодня/.test(dialogue), 'невыделенное слово остаётся обычным');
});

test('пунктуация не мешает сопоставить выделенное слово', () => {
  const ass = toAss(
    [
      {
        start: 0,
        end: 2,
        text: 'Внимание, скидка!',
        words: [{ start: 0, end: 1, text: 'скидка', highlight: true }],
      },
    ],
    { ...base, style: 'clean' },
  );
  assert.match(/^Dialogue: .*,,(.*)$/m.exec(ass)[1], /\{\\c[^}]+\}скидка!/);
});

test('без выделенных слов реплика остаётся простым текстом', () => {
  const ass = toAss([{ start: 0, end: 2, text: 'обычный текст', words: [] }], base);
  assert.equal(/^Dialogue: .*,,(.*)$/m.exec(ass)[1], 'обычный текст');
});

// ── Безопасность и масштабирование ────────────────────────────────────────

test('фигурные скобки в тексте экранируются и не становятся командой ASS', () => {
  assert.match(toAss([{ start: 0, end: 1, text: 'цена {скидка} 50%' }], base), /\\\{скидка\\\}/);
});

test('§4.1: кегль субтитров пропорционален кадру во всех разрешениях', () => {
  const ratios = Object.values(RESOLUTIONS).map(({ width, height }) => {
    const ass = toAss([], { ...base, style: 'bold', width, height });
    return Number(/^Style: Reelio,[^,]+,(\d+),/m.exec(ass)[1]) / height;
  });

  for (const ratio of ratios) {
    assert.ok(Math.abs(ratio - ratios[0]) < 0.002, `доли кегля разошлись: ${ratios.join(', ')}`);
  }
});

test('нижний отступ субтитров равен безопасной зоне', () => {
  const fields = /^Style: Reelio,(.*)$/m.exec(toAss([], { ...base, position: 'bottom' }))[1].split(',');
  assert.ok(Math.abs(Number(fields[20]) / FRAME.height - 0.2) < 0.01);
});
