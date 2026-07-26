import assert from 'node:assert/strict';
import { test } from 'node:test';

import { displayDimensions, frameRateOf, rotationOf } from '../../src/probe.js';

const stream = (over = {}) => ({ codec_type: 'video', width: 1920, height: 1080, ...over });

test('без метаданных поворота размеры не меняются', () => {
  assert.equal(rotationOf(stream()), 0);
  assert.deepEqual(displayDimensions(stream()), { rotation: 0, width: 1920, height: 1080 });
});

test('display matrix −90° разворачивает кадр в вертикальный', () => {
  const s = stream({ side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }] });
  assert.equal(rotationOf(s), 270);
  assert.deepEqual(displayDimensions(s), { rotation: 270, width: 1080, height: 1920 });
});

test('поворот 90° тоже меняет стороны местами', () => {
  const s = stream({ side_data_list: [{ rotation: 90 }] });
  assert.deepEqual(displayDimensions(s), { rotation: 90, width: 1080, height: 1920 });
});

test('поворот 180° сохраняет ориентацию кадра', () => {
  const s = stream({ side_data_list: [{ rotation: 180 }] });
  assert.deepEqual(displayDimensions(s), { rotation: 180, width: 1920, height: 1080 });
});

test('устаревший тег rotate учитывается наравне с display matrix', () => {
  const s = stream({ tags: { rotate: '270' } });
  assert.equal(rotationOf(s), 270);
  assert.deepEqual(displayDimensions(s), { rotation: 270, width: 1080, height: 1920 });
});

test('display matrix имеет приоритет над устаревшим тегом', () => {
  const s = stream({ side_data_list: [{ rotation: -90 }], tags: { rotate: '180' } });
  assert.equal(rotationOf(s), 270);
});

test('угол нормализуется к диапазону 0..359', () => {
  assert.equal(rotationOf(stream({ side_data_list: [{ rotation: -450 }] })), 270);
  assert.equal(rotationOf(stream({ side_data_list: [{ rotation: 720 }] })), 0);
});

test('дробная частота кадров считается из отношения', () => {
  assert.equal(frameRateOf({ avg_frame_rate: '30/1' }), 30);
  assert.ok(Math.abs(frameRateOf({ avg_frame_rate: '30000/1001' }) - 29.97) < 0.01);
  assert.equal(frameRateOf({ avg_frame_rate: '0/0' }), null);
  assert.equal(frameRateOf({}), null);
});
