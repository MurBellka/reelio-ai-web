// Защита от дрейфа: worker — отдельный деплой и держит собственную копию
// таблиц контракта. Этот тест парсит сам docs/render-contract.md и сверяет
// числа с константами src/contract.js. Если контракт правят — тест краснеет.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import {
  ALLOWED_FPS,
  CONTRACT_TRANSITIONS,
  CONTRACT_VERSION,
  MAX_CLIPS,
  MAX_DURATION_SECONDS,
  PHASES,
  RESOLUTIONS,
} from '../../src/contract.js';
import { DUCKING } from '../../src/filtergraph.js';
import { REPO_ROOT } from '../helpers/fixtures.js';

const CONTRACT_PATH = path.join(REPO_ROOT, 'docs/render-contract.md');
const doc = await readFile(CONTRACT_PATH, 'utf8');

/** Ячейки строки markdown-таблицы. */
function cells(line) {
  return line
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim());
}

function tableRows(startPattern) {
  const lines = doc.split('\n');
  const start = lines.findIndex((l) => startPattern.test(l));
  assert.ok(start >= 0, `не найдена таблица по шаблону ${startPattern}`);

  const rows = [];
  for (let i = start + 2; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line.startsWith('|')) break;
    rows.push(cells(line));
  }
  return rows;
}

test('§1: разрешения, кадры, битрейты и уровни совпадают с документом', () => {
  const rows = tableRows(/^\| `resolution` \| Метка \|/);
  const documented = new Map();

  for (const row of rows) {
    const key = row[0].replaceAll('`', '');
    if (key === 'maximumAvailable') continue;

    const [width, height] = row[2].split('×').map((v) => Number(v.trim()));
    const [bitrate, maxrate] = row[3]
      .replace(/Мбит\/с/, '')
      .split('/')
      .map((v) => Number(v.trim()) * 1000);
    const audio = Number(/(\d+)\s*kbps/.exec(row[4])[1]);

    documented.set(key, {
      width,
      height,
      videoBitrateKbps: bitrate,
      maxrateKbps: maxrate,
      audioBitrateKbps: audio,
      level: row[5],
    });
  }

  assert.deepEqual(
    [...documented.keys()].sort(),
    Object.keys(RESOLUTIONS).sort(),
    'набор разрешений разошёлся с §1',
  );

  for (const [key, want] of documented) {
    const got = RESOLUTIONS[key];
    assert.equal(got.width, want.width, `${key}: ширина`);
    assert.equal(got.height, want.height, `${key}: высота`);
    assert.equal(got.videoBitrateKbps, want.videoBitrateKbps, `${key}: битрейт`);
    assert.equal(got.maxrateKbps, want.maxrateKbps, `${key}: maxrate`);
    assert.equal(got.audioBitrateKbps, want.audioBitrateKbps, `${key}: аудио`);
    assert.equal(got.level, want.level, `${key}: level`);
  }
});

test('§4.2: фазы и их диапазоны progress совпадают с документом', () => {
  const rows = tableRows(/^\| `phase` \| `status` \| Диапазон `progress` \|/);
  const documented = new Map();

  for (const row of rows) {
    const phase = row[0].replaceAll('`', '');
    const range = row[2];
    const match = /([\d.]+)\s*–\s*([\d.]+)/.exec(range);
    documented.set(phase, {
      status: row[1],
      from: match ? Number(match[1]) : null,
      to: match ? Number(match[2]) : null,
    });
  }

  assert.deepEqual([...documented.keys()].sort(), Object.keys(PHASES).sort(), 'набор фаз разошёлся');

  for (const [phase, want] of documented) {
    const got = PHASES[phase];
    assert.equal(got.status, want.status, `${phase}: статус`);
    if (want.from !== null) {
      assert.equal(got.from, want.from, `${phase}: начало диапазона`);
      assert.equal(got.to, want.to, `${phase}: конец диапазона`);
    }
  }
});

test('§4.2: диапазоны фаз идут подряд и покрывают 0..1 без разрывов', () => {
  const ordered = ['queued', 'preparing', 'downloading', 'rendering', 'encoding', 'uploading', 'finalizing'];
  assert.equal(PHASES[ordered[0]].from, 0);
  for (let i = 1; i < ordered.length; i += 1) {
    assert.equal(PHASES[ordered[i]].from, PHASES[ordered[i - 1]].to, `разрыв перед ${ordered[i]}`);
  }
  assert.equal(PHASES.finalizing.to, 1);
  assert.equal(PHASES.done.from, 1);
});

test('§2: параметры ducking совпадают с документом', () => {
  assert.match(doc, /sidechaincompress/);
  const threshold = Number(/threshold\s+([\d.]+)/.exec(doc)[1]);
  const ratio = Number(/ratio\s+(\d+)/.exec(doc)[1]);
  const attack = Number(/attack\s+(\d+)\s*мс/.exec(doc)[1]);
  const release = Number(/release\s+(\d+)\s*мс/.exec(doc)[1]);
  const factor = Number(/music\.volume\s*×\s*([\d.]+)/.exec(doc)[1]);

  assert.equal(DUCKING.threshold, threshold);
  assert.equal(DUCKING.ratio, ratio);
  assert.equal(DUCKING.attackMs, attack);
  assert.equal(DUCKING.releaseMs, release);
  assert.equal(DUCKING.duckedLevelFactor, factor);
});

test('§1/§2: потолки и допустимые значения совпадают с документом', () => {
  assert.match(doc, new RegExp(`Σ clips\\[\\]\\.duration ≤ ${MAX_DURATION_SECONDS}`));
  assert.match(doc, new RegExp(`clips\` непусто, ≤ ${MAX_CLIPS} элементов`));
  assert.match(doc, new RegExp(`fps\\s+:\\s+${ALLOWED_FPS[0]} \\(по умолчанию\\) либо ${ALLOWED_FPS[1]}`));
  assert.match(doc, new RegExp(`Версия контракта — \`render-contract/${CONTRACT_VERSION}\``));
});

test('§2: набор контрактных переходов не изменился', () => {
  // Перечисление живёт в комментарии к полю transition в примере §2.
  const line = /"transition":\s*"[^"]+",\s*\/\/\s*(.+)$/m.exec(doc)[1];
  const documented = line.split('|').map((v) => v.trim());
  assert.deepEqual(documented.sort(), [...CONTRACT_TRANSITIONS].sort());
});

test('§1: обязательные параметры контейнера присутствуют в реализации', () => {
  // Строки из блока «Общие параметры контейнера».
  assert.match(doc, /container : mp4\s+\(\+faststart\)/);
  assert.match(doc, /video\s+: h264 \(libx264\), profile high, yuv420p, GOP = 2 × fps/);
  assert.match(doc, /audio\s+: aac, 48 kHz, stereo/);
});
