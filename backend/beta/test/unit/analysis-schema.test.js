import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  GEMINI_ANALYSIS_SCHEMA,
  GEMINI_SPEECH_SCHEMA,
  validateMediaAnalysis,
} from '../../src/analysis-schema.js';
import { UnsafeModelOutputError } from '../../src/sanitize.js';
import { findMusicMention } from '../../src/prompts.js';

const CTX = { assetId: 'asset_a', type: 'video', durationSeconds: 10, width: 1080, height: 1920 };

const GOOD = {
  summary: 'Прогулка по набережной',
  quality: { overall: 0.8, sharpness: 0.7, exposure: 0.6, stability: 0.9 },
  scenes: [
    { start: 0, end: 4, shotType: 'wide', motion: 'slow', quality: 0.8 },
    { start: 4, end: 10, shotType: 'closeup', motion: 'fast', quality: 0.6 },
  ],
  subjects: [
    { kind: 'person', box: { x: 0.3, y: 0.2, width: 0.4, height: 0.5 }, isPrimary: true, confidence: 0.9 },
  ],
  moments: [{ start: 1, end: 3.5, kind: 'highlight', score: 0.9, reason: 'самый динамичный кусок' }],
  issues: ['shaky'],
};

test('корректный анализ нормализуется', () => {
  const result = validateMediaAnalysis(GOOD, CTX);

  assert.equal(result.assetId, 'asset_a');
  assert.equal(result.scenes.length, 2);
  assert.equal(result.moments.length, 1);
  assert.deepEqual(result.issues, ['shaky']);
  assert.equal(result.quality.overall, 0.8);
});

test('технические характеристики берутся измеренные, а не от модели', () => {
  const lying = { ...GOOD, durationSeconds: 9999, width: 42, height: 42 };
  const result = validateMediaAnalysis(lying, CTX);

  assert.equal(result.durationSeconds, 10);
  assert.equal(result.width, 1080);
  assert.equal(result.height, 1920);
});

// ── §5: только кадрирование, без биометрии ────────────────────────────────

test('§5: у объекта нет полей личности — только прямоугольник', () => {
  const withIdentity = {
    ...GOOD,
    subjects: [
      {
        kind: 'person',
        box: { x: 0.3, y: 0.2, width: 0.4, height: 0.5 },
        isPrimary: true,
        // Всё это модель может попытаться прислать — ничего не должно выжить.
        name: 'Иван Петров',
        age: 34,
        gender: 'male',
        ethnicity: 'slavic',
        faceEmbedding: [0.1, 0.2, 0.3],
        personId: 'person_42',
      },
    ],
  };

  const subject = validateMediaAnalysis(withIdentity, CTX).subjects[0];
  for (const forbidden of ['name', 'age', 'gender', 'ethnicity', 'faceEmbedding', 'personId']) {
    assert.ok(!(forbidden in subject), `поле «${forbidden}» не должно сохраняться`);
  }
  assert.deepEqual(Object.keys(subject).sort(), [
    'atSeconds',
    'box',
    'center',
    'confidence',
    'isPrimary',
    'kind',
  ]);
});

test('§5: главный объект даёт центр кадрирования', () => {
  const result = validateMediaAnalysis(GOOD, CTX);
  assert.deepEqual(result.framingCenter, { x: 0.5, y: 0.45 });
});

test('§5: без объектов центра кадрирования нет — и это не ошибка', () => {
  const result = validateMediaAnalysis({ ...GOOD, subjects: [] }, CTX);
  assert.equal(result.framingCenter, null);
  assert.deepEqual(result.subjects, []);
});

test('§5: схема для модели не содержит полей личности', () => {
  const schema = JSON.stringify(GEMINI_ANALYSIS_SCHEMA).toLowerCase();
  for (const forbidden of ['name', 'age', 'gender', 'ethnic', 'embedding', 'identity', 'personid']) {
    assert.ok(!schema.includes(forbidden), `схема содержит «${forbidden}»`);
  }
});

// ── §9: музыки нет ────────────────────────────────────────────────────────

test('§9: в схемах анализа нет музыкальных полей', () => {
  for (const [name, schema] of Object.entries({ GEMINI_ANALYSIS_SCHEMA, GEMINI_SPEECH_SCHEMA })) {
    const found = findMusicMention(JSON.stringify(schema));
    assert.equal(found, null, `${name} упоминает музыку: «${found}»`);
  }
});

// ── §7: мусор не проходит ─────────────────────────────────────────────────

test('не-объект отвергается', () => {
  for (const garbage of [null, 'строка', 42, [], undefined]) {
    assert.throws(() => validateMediaAnalysis(garbage, CTX), UnsafeModelOutputError);
  }
});

test('видео без сцен и моментов отвергается как мусорный ответ', () => {
  assert.throws(
    () => validateMediaAnalysis({ scenes: [], moments: [] }, CTX),
    (err) => {
      assert.equal(err.code, 'MODEL_OUTPUT_REJECTED');
      assert.match(err.field, /scenes/);
      return true;
    },
  );
});

test('фото без сцен — норма, у него нет таймлайна', () => {
  const photo = validateMediaAnalysis(
    { scenes: [], subjects: [], quality: { overall: 0.7 } },
    { ...CTX, type: 'photo', durationSeconds: 0 },
  );
  assert.equal(photo.type, 'photo');
  assert.deepEqual(photo.scenes, []);
});

test('сцены за пределами длительности зажимаются', () => {
  const result = validateMediaAnalysis(
    { scenes: [{ start: -5, end: 9999 }] },
    CTX,
  );
  assert.equal(result.scenes[0].start, 0);
  assert.equal(result.scenes[0].end, 10);
});

test('прямоугольник не может вылезать за кадр', () => {
  const result = validateMediaAnalysis(
    { ...GOOD, subjects: [{ kind: 'face', box: { x: 0.8, y: 0.9, width: 0.9, height: 0.9 } }] },
    CTX,
  );
  const box = result.subjects[0].box;
  assert.ok(box.x + box.width <= 1.0001, `${box.x}+${box.width}`);
  assert.ok(box.y + box.height <= 1.0001);
});

test('битые прямоугольники отбрасываются, а не превращаются в нули', () => {
  const result = validateMediaAnalysis(
    {
      ...GOOD,
      subjects: [
        { kind: 'person', box: { x: 'левее', y: null, width: 0, height: 0 } },
        { kind: 'person', box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } },
      ],
    },
    CTX,
  );
  assert.equal(result.subjects.length, 1);
});

test('неизвестные перечисления заменяются безопасным значением', () => {
  const result = validateMediaAnalysis(
    {
      scenes: [{ start: 0, end: 5, shotType: 'дрон', motion: 'бешеное' }],
      subjects: [{ kind: 'инопланетянин', box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } }],
      moments: [{ start: 0, end: 2, kind: 'вирусный' }],
      issues: ['проклятие', 'blurry'],
    },
    CTX,
  );

  assert.equal(result.scenes[0].shotType, 'unknown');
  assert.equal(result.scenes[0].motion, 'moderate');
  assert.equal(result.subjects[0].kind, 'unknown');
  assert.equal(result.moments[0].kind, 'highlight');
  assert.deepEqual(result.issues, ['blurry']);
});

test('текст, похожий на путь, в reason отвергает весь анализ', () => {
  assert.throws(
    () =>
      validateMediaAnalysis(
        { ...GOOD, moments: [{ start: 0, end: 2, reason: 'см. gs://bucket/secret.mp4' }] },
        CTX,
      ),
    UnsafeModelOutputError,
  );
});

test('моменты сортируются по убыванию оценки', () => {
  const result = validateMediaAnalysis(
    {
      ...GOOD,
      moments: [
        { start: 0, end: 1, score: 0.3 },
        { start: 2, end: 3, score: 0.9 },
        { start: 4, end: 5, score: 0.6 },
      ],
    },
    CTX,
  );
  assert.deepEqual(result.moments.map((m) => m.score), [0.9, 0.6, 0.3]);
});

// ── Речь ──────────────────────────────────────────────────────────────────

test('речь нормализуется и сортируется по времени', () => {
  const result = validateMediaAnalysis(
    {
      ...GOOD,
      speech: {
        language: 'ru',
        segments: [
          { start: 5, end: 7, text: 'вторая' },
          { start: 1, end: 3, text: 'первая', words: [{ start: 1, end: 2, text: 'пер' }] },
        ],
      },
    },
    CTX,
  );

  assert.equal(result.speech.hasSpeech, true);
  assert.equal(result.speech.language, 'ru');
  assert.deepEqual(result.speech.segments.map((s) => s.text), ['первая', 'вторая']);
  assert.equal(result.speech.segments[0].words[0].text, 'пер');
});

test('пустые и нулевой длины реплики отбрасываются', () => {
  const result = validateMediaAnalysis(
    {
      ...GOOD,
      speech: {
        segments: [
          { start: 1, end: 1, text: 'нулевая' },
          { start: 2, end: 3, text: '   ' },
          { start: 4, end: 5, text: 'нормальная' },
        ],
      },
    },
    CTX,
  );
  assert.equal(result.speech.segments.length, 1);
});

test('некорректный тег языка отбрасывается', () => {
  for (const bad of ['русский язык', 'r', '12', 'ru; drop']) {
    const result = validateMediaAnalysis(
      { ...GOOD, speech: { language: bad, segments: [{ start: 0, end: 1, text: 'а' }] } },
      CTX,
    );
    assert.equal(result.speech.language, null, `тег «${bad}» не должен приниматься`);
  }
});

test('отсутствие речи — валидное состояние', () => {
  const result = validateMediaAnalysis(GOOD, CTX);
  assert.equal(result.speech.hasSpeech, false);
  assert.deepEqual(result.speech.segments, []);
});
