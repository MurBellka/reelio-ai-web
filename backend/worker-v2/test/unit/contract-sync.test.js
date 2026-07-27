// Защита от дрейфа: worker v2 — отдельный деплой и держит собственные копии
// таблиц контракта. Этот тест парсит сами документы (v1 для унаследованных
// таблиц, v2 для новых) и сверяет числа с константами src/. Правка контракта
// без правки кода красит тест.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import {
  ALLOWED_FPS,
  ANCHOR_Y,
  CAPTION_STYLES,
  CONTRACT_VERSION,
  EXPORT_PRESETS,
  JOIN_FADE_MS,
  LOUDNESS_TARGET_LUFS,
  LOUDNESS_TRUE_PEAK_DB,
  MAX_CLIPS,
  MAX_DURATION_SECONDS,
  MAX_TEXT_OVERLAYS,
  PHASES,
  RESOLUTIONS,
  SAFE_ZONE,
  SUPPORTED_PLAN_VERSIONS,
} from '../../src/contract.js';
import { FONT_CATALOG } from '../../src/fonts.js';
import {
  INTENSITY_DURATIONS,
  MAX_TRANSITION_SECONDS,
  MIN_TRANSITION_SECONDS,
  TRANSITION_CATALOG,
} from '../../src/transitions.js';
import { REPO_ROOT } from '../helpers/fixtures.js';

const v1 = await readFile(path.join(REPO_ROOT, 'docs/render-contract.md'), 'utf8');
const v2 = await readFile(path.join(REPO_ROOT, 'docs/render-contract-v2.md'), 'utf8');

/** Строки markdown-таблицы, начиная с заголовка по шаблону. */
function tableRows(doc, startPattern) {
  const lines = doc.split('\n');
  const start = lines.findIndex((l) => startPattern.test(l));
  assert.ok(start >= 0, `не найдена таблица по шаблону ${startPattern}`);

  const rows = [];
  for (let i = start + 2; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line.startsWith('|')) break;
    rows.push(
      line
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim()),
    );
  }
  return rows;
}

const unquote = (cell) => cell.replaceAll('`', '').trim();

// ── Унаследованное из v1 ──────────────────────────────────────────────────

test('§1 v1: разрешения, битрейты и уровни совпадают с документом', () => {
  const documented = new Map();
  for (const row of tableRows(v1, /^\| `resolution` \| Метка \|/)) {
    const key = unquote(row[0]);
    if (key === 'maximumAvailable') continue;

    const [width, height] = row[2].split('×').map((v) => Number(v.trim()));
    const [bitrate, maxrate] = row[3]
      .replace(/Мбит\/с/, '')
      .split('/')
      .map((v) => Number(v.trim()) * 1000);

    documented.set(key, {
      width,
      height,
      videoBitrateKbps: bitrate,
      maxrateKbps: maxrate,
      audioBitrateKbps: Number(/(\d+)\s*kbps/.exec(row[4])[1]),
      level: row[5],
    });
  }

  assert.deepEqual([...documented.keys()].sort(), Object.keys(RESOLUTIONS).sort());
  for (const [key, want] of documented) {
    assert.deepEqual(
      {
        width: RESOLUTIONS[key].width,
        height: RESOLUTIONS[key].height,
        videoBitrateKbps: RESOLUTIONS[key].videoBitrateKbps,
        maxrateKbps: RESOLUTIONS[key].maxrateKbps,
        audioBitrateKbps: RESOLUTIONS[key].audioBitrateKbps,
        level: RESOLUTIONS[key].level,
      },
      want,
      `разрешение ${key}`,
    );
  }
});

test('§4.2 v1: фазы и диапазоны progress совпадают с документом', () => {
  const documented = new Map();
  for (const row of tableRows(v1, /^\| `phase` \| `status` \| Диапазон `progress` \|/)) {
    const match = /([\d.]+)\s*–\s*([\d.]+)/.exec(row[2]);
    documented.set(unquote(row[0]), {
      status: row[1],
      from: match ? Number(match[1]) : null,
      to: match ? Number(match[2]) : null,
    });
  }

  assert.deepEqual([...documented.keys()].sort(), Object.keys(PHASES).sort());
  for (const [phase, want] of documented) {
    assert.equal(PHASES[phase].status, want.status, `${phase}: статус`);
    if (want.from !== null) {
      assert.equal(PHASES[phase].from, want.from, `${phase}: начало`);
      assert.equal(PHASES[phase].to, want.to, `${phase}: конец`);
    }
  }
});

test('§1/§2 v1: потолки продукта не разошлись', () => {
  assert.match(v1, new RegExp(`Σ clips\\[\\]\\.duration ≤ ${MAX_DURATION_SECONDS}`));
  assert.match(v1, new RegExp(`clips\` непусто, ≤ ${MAX_CLIPS} элементов`));
  assert.match(v1, new RegExp(`fps\\s+:\\s+${ALLOWED_FPS[0]} \\(по умолчанию\\) либо ${ALLOWED_FPS[1]}`));
});

// ── Новое в v2 ────────────────────────────────────────────────────────────

test('§0 v2: версия контракта и принимаемые версии планов', () => {
  assert.match(v2, new RegExp(`Версия контракта — \`render-contract/${CONTRACT_VERSION}\``));
  assert.deepEqual(SUPPORTED_PLAN_VERSIONS, [1, 2]);
  // Документ обязан обещать приём планов v1.
  assert.match(v2, /Worker v2 обязан принимать план v1/);
});

test('§0 v2: поле music объявлено устаревшим и игнорируемым', () => {
  assert.match(v2, /\| `plan\.music` \| deprecated \|/);
  assert.match(v2, /игнорируется/i);
});

test('§2.1 v2: каталог переходов совпадает с документом', () => {
  const documented = new Map();
  for (const row of tableRows(v2, /^\| `type` \| Фильтр FFmpeg \| Группа \|/)) {
    const type = unquote(row[0]);
    const filter = unquote(row[1]);
    documented.set(type, filter === '—' ? null : /xfade=(\w+)/.exec(filter)?.[1] ?? null);
  }

  assert.deepEqual(
    [...documented.keys()].sort(),
    Object.keys(TRANSITION_CATALOG).sort(),
    'набор переходов разошёлся с §2.1',
  );
  for (const [type, xfade] of documented) {
    assert.equal(TRANSITION_CATALOG[type].xfade, xfade, `переход ${type}`);
  }
});

test('§2.3 v2: длительности по интенсивности и пределы совпадают', () => {
  const documented = {};
  for (const row of tableRows(v2, /^\| `intensity` \| Длительность по умолчанию \|/)) {
    documented[unquote(row[0])] = Number(/([\d.]+)/.exec(row[1])[1]);
  }

  assert.deepEqual(documented, INTENSITY_DURATIONS);
  assert.match(
    v2,
    new RegExp(`${MIN_TRANSITION_SECONDS}\\s*\\.\\.\\s*${MAX_TRANSITION_SECONDS}`),
    'диапазон длительности перехода',
  );
});

test('§4.2 v2: безопасная зона совпадает с документом', () => {
  const documented = {};
  const names = { сверху: 'top', снизу: 'bottom', слева: 'left', справа: 'right' };
  for (const row of tableRows(v2, /^\| Сторона \| Доля \|/)) {
    documented[names[row[0]]] = Number(row[1]);
  }

  assert.deepEqual(documented, SAFE_ZONE);
});

test('§4.2 v2: значения y по умолчанию для якорей совпадают', () => {
  // Числа заканчиваются точкой предложения — её захватывать нельзя.
  const match = /`top` → (0\.\d+), `center` → (0\.\d+),\s*`bottom` → (0\.\d+)/.exec(v2);
  assert.ok(match, 'в §4.2 не найдены значения якорей');
  assert.deepEqual(
    { top: Number(match[1]), center: Number(match[2]), bottom: Number(match[3]) },
    ANCHOR_Y,
  );
});

test('§4 v2: лимит текстовых слоёв совпадает', () => {
  assert.match(v2, new RegExp(`до ${MAX_TEXT_OVERLAYS} элементов`));
});

test('§5 v2: каталог шрифтов совпадает с документом', () => {
  const documented = new Map();
  for (const row of tableRows(v2, /^\| `fontId` \| Семейство \| Группа \| Лицензия \|/)) {
    documented.set(unquote(row[0]), { family: row[1], license: row[3] });
  }

  assert.deepEqual([...documented.keys()].sort(), Object.keys(FONT_CATALOG).sort());
  for (const [fontId, want] of documented) {
    assert.equal(FONT_CATALOG[fontId].family, want.family, `${fontId}: семейство`);
    assert.equal(
      FONT_CATALOG[fontId].license,
      want.license.replace(' ', '-'),
      `${fontId}: лицензия`,
    );
  }
});

test('§6 v2: набор стилей субтитров совпадает', () => {
  const line = /"style":\s*"[^"]+",\s*\/\/\s*(.+)$/m.exec(v2)[1];
  const documented = line.split('|').map((v) => v.trim());
  assert.deepEqual(documented.sort(), [...CAPTION_STYLES].sort());
});

test('§1 v2: параметры звука совпадают с документом', () => {
  assert.match(v2, new RegExp(`микрофейд по ${JOIN_FADE_MS} мс`));
  assert.match(v2, new RegExp(`цель −?${Math.abs(LOUDNESS_TARGET_LUFS)} LUFS`));
  assert.match(v2, new RegExp(`TP −?${Math.abs(LOUDNESS_TRUE_PEAK_DB)} dBTP`));
});

test('§8 v2: пресет Instagram Reels совпадает с документом', () => {
  const preset = EXPORT_PRESETS.instagramReels;
  assert.equal(preset.resolution, 'fullHd1080');
  assert.equal(preset.fps, 30);

  assert.match(v2, /resolution : fullHd1080 \(1080 × 1920\)/);
  assert.match(v2, /fps\s+: 30/);
  assert.match(v2, /container\s+: mp4 \+faststart/);
});

test('§8 v2: пресет обещает возможность ролика без звука', () => {
  assert.match(v2, /либо дорожки нет вовсе/);
});
