import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  assTimecode,
  buildCues,
  hexToAssColor,
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

test('таймкод SRT — часы:минуты:секунды,миллисекунды', () => {
  assert.equal(srtTimecode(0), '00:00:00,000');
  assert.equal(srtTimecode(3.25), '00:00:03,250');
  assert.equal(srtTimecode(3661.5), '01:01:01,500');
});

test('таймкод ASS — сотые доли без ведущего нуля в часах', () => {
  assert.equal(assTimecode(0), '0:00:00.00');
  assert.equal(assTimecode(3.25), '0:00:03.25');
  assert.equal(assTimecode(3661.5), '1:01:01.50');
});

test('цвет ASS хранится как ABGR', () => {
  // #FF0000 (красный) → &H000000FF: R уходит в младший байт.
  assert.equal(hexToAssColor('#FF0000'), '&H000000FF');
  assert.equal(hexToAssColor('#FFFFFF'), '&H00FFFFFF');
  assert.equal(hexToAssColor('#123456'), '&H00563412');
});

test('некорректный цвет деградирует в белый, а не роняет генерацию', () => {
  assert.equal(hexToAssColor('не цвет'), '&H00FFFFFF');
});

test('перенос не разрывает слова', () => {
  const lines = wrapText('Лучшие моменты поездки на море', 14);
  assert.ok(lines.length >= 2);
  for (const line of lines) {
    assert.ok(!line.startsWith(' ') && !line.endsWith(' '));
  }
  assert.equal(lines.join(' '), 'Лучшие моменты поездки на море');
});

test('перенос не теряет текст при превышении лимита строк', () => {
  const text = 'один два три четыре пять шесть семь восемь девять десять';
  const lines = wrapText(text, 10, 2);
  assert.equal(lines.length, 2);
  assert.equal(lines.join(' '), text);
});

test('текст делится на части по числу клипов без потерь', () => {
  const chunks = splitIntoChunks('раз два три четыре пять шесть', 3);
  assert.equal(chunks.length, 3);
  assert.equal(chunks.join(' '), 'раз два три четыре пять шесть');
});

test('частей не больше, чем слов', () => {
  const chunks = splitIntoChunks('одно слово', 10);
  assert.equal(chunks.length, 2);
});

test('реплики раскладываются по клипам внутри их границ', () => {
  const cues = buildCues({
    captions: { enabled: true, sampleText: 'Лучшие моменты поездки на море сегодня' },
    segments,
  });
  assert.equal(cues.length, 3);
  cues.forEach((cue, i) => {
    assert.ok(cue.start >= segments[i].start, 'реплика не начинается раньше клипа');
    assert.ok(cue.end <= segments[i].end, 'реплика не выходит за клип');
    assert.ok(cue.end > cue.start);
  });
});

test('выключенные субтитры не дают реплик', () => {
  assert.deepEqual(buildCues({ captions: { enabled: false, sampleText: 'текст' }, segments }), []);
});

test('пустой текст не даёт реплик', () => {
  assert.deepEqual(buildCues({ captions: { enabled: true, sampleText: '   ' }, segments }), []);
});

test('готовые cues из плана имеют приоритет над sampleText', () => {
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
  assert.deepEqual(
    cues.map((c) => c.text),
    ['первая', 'вторая'],
    'реплики должны быть отсортированы по времени',
  );
});

test('SRT нумерует реплики с единицы и использует стрелку', () => {
  const srt = toSrt([{ start: 0, end: 2, text: 'Привет, мир' }]);
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:02,000\nПривет, мир\n$/);
});

test('ASS содержит кириллическую кодировку и размер кадра', () => {
  const ass = toAss([{ start: 0, end: 2, text: 'Привет' }], {
    style: 'clean',
    colorHex: '#FFFFFF',
    width: 1080,
    height: 1920,
  });
  assert.match(ass, /PlayResX: 1080/);
  assert.match(ass, /PlayResY: 1920/);
  assert.match(ass, /,204$/m, 'Encoding 204 — кириллица');
  assert.match(ass, /^Dialogue: 0,0:00:00\.00,0:00:02\.00,Reelio,,0,0,0,,Привет$/m);
});

test('стиль bold заметно крупнее и жирнее, чем clean', () => {
  const opts = { colorHex: '#FFFFFF', width: 1080, height: 1920 };
  const sizeOf = (style) => Number(/^Style: Reelio,[^,]+,(\d+),/m.exec(toAss([], { ...opts, style }))[1]);
  assert.ok(sizeOf('bold') > sizeOf('clean'));
  assert.match(toAss([], { ...opts, style: 'bold' }), /^Style: Reelio,[^,]+,\d+,[^,]+,[^,]+,[^,]+,[^,]+,1,/m);
});

test('karaoke размечает слова тегами \\k с суммой, равной длине реплики', () => {
  const ass = toAss([{ start: 0, end: 3, text: 'раз два три' }], {
    style: 'karaoke',
    colorHex: '#FFD400',
    width: 720,
    height: 1280,
  });
  const dialogue = /^Dialogue: .*,,(.*)$/m.exec(ass)[1];
  const centis = [...dialogue.matchAll(/\{\\k(\d+)\}/g)].map((m) => Number(m[1]));
  assert.equal(centis.length, 3, 'по одному тегу на слово');
  assert.equal(
    centis.reduce((a, b) => a + b, 0),
    300,
    'сумма долей равна длительности реплики в сотых',
  );
});

test('фигурные скобки в тексте экранируются и не становятся ASS-командой', () => {
  const ass = toAss([{ start: 0, end: 1, text: 'цена {скидка} 50%' }], {
    style: 'clean',
    colorHex: '#FFFFFF',
    width: 720,
    height: 1280,
  });
  assert.match(ass, /\\\{скидка\\\}/);
});

test('кегль масштабируется вместе с разрешением', () => {
  const opts = { style: 'bold', colorHex: '#FFFFFF' };
  const sizeOf = (height) =>
    Number(/^Style: Reelio,[^,]+,(\d+),/m.exec(toAss([], { ...opts, width: height / 16 * 9, height }))[1]);
  assert.ok(sizeOf(3840) > sizeOf(1920));
  assert.ok(sizeOf(1920) > sizeOf(1280));
});
