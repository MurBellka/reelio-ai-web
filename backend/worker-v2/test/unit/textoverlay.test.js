import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RESOLUTIONS, SAFE_ZONE, isInsideSafeZone } from '../../src/contract.js';
import {
  assColor,
  escapeAssText,
  normalizeOverlay,
  overlaysToAss,
  wrapText,
} from '../../src/textoverlay.js';

const SEGMENTS = [
  { id: 'clip_1', start: 0, end: 3, clip: { duration: 3 } },
  { id: 'clip_2', start: 3, end: 7, clip: { duration: 4 } },
];
const CTX = { index: 0, segments: SEGMENTS, totalDuration: 7 };

function make(raw, ctx = {}) {
  return normalizeOverlay(raw, { ...CTX, ...ctx });
}

const BASE = { text: 'Наша поездка', startSeconds: 1, endSeconds: 4 };

test('минимальный слой разбирается с умолчаниями', () => {
  const { overlay, error } = make(BASE);
  assert.equal(error, null);
  assert.equal(overlay.text, 'Наша поездка');
  assert.equal(overlay.start, 1);
  assert.equal(overlay.end, 4);
  assert.equal(overlay.align, 'center');
  assert.equal(overlay.animation, 'none');
  assert.equal(overlay.opacity, 1);
  assert.equal(overlay.fontId, 'inter');
});

test('якорь задаёт вертикальное положение, явный y его перекрывает', () => {
  assert.equal(make({ ...BASE, position: { anchor: 'top' } }).overlay.y, 0.18);
  assert.equal(make({ ...BASE, position: { anchor: 'center' } }).overlay.y, 0.5);
  assert.equal(make({ ...BASE, position: { anchor: 'bottom' } }).overlay.y, 0.8);
  assert.equal(make({ ...BASE, position: { anchor: 'top', y: 0.42 } }).overlay.y, 0.42);
});

test('§4.2: текст за пределами безопасной зоны сдвигается внутрь с пометкой', () => {
  // y = 0.95 — под кнопками Reels.
  const { overlay, notes } = make({ ...BASE, position: { x: 0.5, y: 0.95 } });
  assert.equal(overlay.insideSafeZone, false);
  assert.equal(overlay.requestedY, 0.95);
  assert.equal(overlay.y, 1 - SAFE_ZONE.bottom);
  assert.ok(isInsideSafeZone(overlay.x, overlay.y));
  assert.ok(notes.some((n) => n.startsWith('text-safe-zone:')));
});

test('§4.2: текст внутри зоны не двигается и не порождает пометок', () => {
  const { overlay, notes } = make({ ...BASE, position: { x: 0.5, y: 0.5 } });
  assert.equal(overlay.insideSafeZone, true);
  assert.equal(overlay.y, 0.5);
  assert.deepEqual(notes, []);
});

test('края безопасной зоны считаются допустимыми', () => {
  assert.ok(isInsideSafeZone(SAFE_ZONE.left, SAFE_ZONE.top));
  assert.ok(isInsideSafeZone(1 - SAFE_ZONE.right, 1 - SAFE_ZONE.bottom));
  assert.ok(!isInsideSafeZone(SAFE_ZONE.left - 0.01, 0.5));
});

test('привязка к клипу сдвигает время слоя на начало клипа', () => {
  const { overlay } = make({ ...BASE, clipId: 'clip_2', startSeconds: 0.5, endSeconds: 2 });
  assert.equal(overlay.start, 3.5);
  assert.equal(overlay.end, 5);
});

test('слой не переживает клип, к которому привязан', () => {
  const { overlay } = make({ ...BASE, clipId: 'clip_1', startSeconds: 0, endSeconds: 100 });
  assert.equal(overlay.end, 3, 'конец обрезан по концу клипа');
});

test('привязка к несуществующему клипу — ошибка', () => {
  const { error } = make({ ...BASE, clipId: 'clip_404' });
  assert.match(error, /неизвестному клипу/);
});

test('пустой и слишком длинный текст отвергаются', () => {
  assert.match(make({ ...BASE, text: '   ' }).error, /пустой текст/);
  assert.match(make({ ...BASE, text: 'я'.repeat(201) }).error, /длиннее/);
});

test('слишком короткий слой отвергается', () => {
  assert.match(make({ ...BASE, startSeconds: 1, endSeconds: 1.05 }).error, /короче/);
});

test('кегль зажимается в допустимые доли высоты', () => {
  assert.equal(make({ ...BASE, fontSizeRatio: 0.9 }).overlay.fontSizeRatio, 0.15);
  assert.equal(make({ ...BASE, fontSizeRatio: 0.001 }).overlay.fontSizeRatio, 0.02);
});

test('плашка и обводка вместе не поддерживаются: остаётся плашка', () => {
  const { overlay, notes } = make({
    ...BASE,
    background: { colorHex: '#000000', opacity: 0.5 },
    outline: { colorHex: '#FFFFFF', widthRatio: 0.01 },
  });
  assert.ok(overlay.background);
  assert.equal(overlay.outline, null);
  assert.ok(notes.some((n) => n.startsWith('text-style:')));
});

test('неизвестный шрифт откатывается к умолчанию с пометкой', () => {
  const { overlay, notes } = make({ ...BASE, fontId: 'comic' });
  assert.equal(overlay.fontId, 'inter');
  assert.ok(notes.some((n) => n.startsWith('font-fallback:')));
});

test('цвет ASS хранится как ABGR с инвертированной альфой', () => {
  // Непрозрачный красный: альфа 00, порядок BGR.
  assert.equal(assColor('#FF0000', 1), '&H000000FF');
  // Полностью прозрачный.
  assert.equal(assColor('#FF0000', 0), '&HFF0000FF');
  assert.equal(assColor('#123456', 1), '&H00563412');
});

test('перенос по словам не рвёт слова', () => {
  const lines = wrapText('Лучшие моменты поездки на море', 14);
  assert.equal(lines.join(' '), 'Лучшие моменты поездки на море');
  assert.ok(lines.length >= 2);
});

// ── Защита от инъекций (§4.3) ─────────────────────────────────────────────

test('спецсимволы filtergraph экранируются или безопасны в ASS', () => {
  const nasty = String.raw`a:b,c;d[e]f'g\h{i}j`;
  const escaped = escapeAssText(nasty);
  // Только скобки и слэш имеют значение в ASS — они экранированы.
  assert.ok(escaped.includes('\\{'));
  assert.ok(escaped.includes('\\}'));
  assert.ok(escaped.includes('\\\\'));
  // Двоеточия и запятые остаются как есть: в файле .ass они безвредны.
  assert.ok(escaped.includes(':'));
  assert.ok(escaped.includes(','));
});

test('попытка инъекции команд ASS не порождает управляющий блок', () => {
  const { overlay } = make({ ...BASE, text: '{\\an7\\pos(0,0)}взлом' });
  const ass = overlaysToAss([overlay], { width: 1080, height: 1920 });
  const dialogue = /^Dialogue: .*$/m.exec(ass)[0];

  // Ровно один служебный блок — наш собственный, в начале строки.
  const blocks = dialogue.match(/(?<!\\)\{/g) ?? [];
  assert.equal(blocks.length, 1, `в событии должен быть один блок команд: ${dialogue}`);
  assert.ok(dialogue.includes('\\{'), 'скобки пользователя экранированы');
});

test('перевод строки в тексте превращается в \\N, а не рвёт файл', () => {
  const { overlay } = make({ ...BASE, text: 'первая\nвторая' });
  const ass = overlaysToAss([overlay], { width: 1080, height: 1920 });
  const dialogues = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
  assert.equal(dialogues.length, 1, 'текст не должен разъехаться на два события');
  assert.ok(dialogues[0].includes('\\N'));
});

// ── Совпадение позиции во всех разрешениях (§4.1) ─────────────────────────

test('§4.1: позиция и кегль пропорциональны кадру во всех четырёх разрешениях', () => {
  const { overlay } = make({
    ...BASE,
    position: { x: 0.25, y: 0.4 },
    fontSizeRatio: 0.05,
  });

  const measured = Object.values(RESOLUTIONS).map(({ width, height }) => {
    const ass = overlaysToAss([overlay], { width, height });
    const pos = /\\pos\((\d+),(\d+)\)/.exec(ass);
    const size = /^Style: Overlay0,[^,]+,(\d+),/m.exec(ass);
    assert.ok(pos && size, `${width}x${height}: не нашлось позиции или кегля`);

    return {
      width,
      height,
      xRatio: Number(pos[1]) / width,
      yRatio: Number(pos[2]) / height,
      sizeRatio: Number(size[1]) / height,
      playRes: [
        Number(/PlayResX: (\d+)/.exec(ass)[1]),
        Number(/PlayResY: (\d+)/.exec(ass)[1]),
      ],
    };
  });

  for (const m of measured) {
    assert.ok(Math.abs(m.xRatio - 0.25) < 0.002, `${m.width}: x = ${m.xRatio}`);
    assert.ok(Math.abs(m.yRatio - 0.4) < 0.002, `${m.width}: y = ${m.yRatio}`);
    assert.ok(Math.abs(m.sizeRatio - 0.05) < 0.002, `${m.width}: кегль = ${m.sizeRatio}`);
    assert.deepEqual(m.playRes, [m.width, m.height], 'PlayRes обязан равняться кадру');
  }
});

test('§4.1: доли обводки и тени тоже масштабируются вместе с кадром', () => {
  const { overlay } = make({
    ...BASE,
    outline: { colorHex: '#000000', widthRatio: 0.01 },
    shadow: { colorHex: '#000000', opacity: 0.5, offsetRatio: 0.005 },
  });

  for (const { width, height } of Object.values(RESOLUTIONS)) {
    const ass = overlaysToAss([overlay], { width, height });
    const style = /^Style: Overlay0,(.*)$/m.exec(ass)[1].split(',');
    // Поля стиля: … BorderStyle(16), Outline(17), Shadow(18) — с учётом Name.
    const outline = Number(style[15]);
    const shadow = Number(style[16]);
    assert.ok(Math.abs(outline / height - 0.01) < 0.002, `${width}: обводка ${outline}`);
    assert.ok(Math.abs(shadow / height - 0.005) < 0.002, `${width}: тень ${shadow}`);
  }
});

// ── Анимации (§4.4) ───────────────────────────────────────────────────────

test('анимация fade добавляет \\fad, slide — \\move, pop — масштабирование', () => {
  const frame = { width: 1080, height: 1920 };

  const fade = overlaysToAss([make({ ...BASE, animation: 'fade' }).overlay], frame);
  assert.match(fade, /\\fad\(\d+,\d+\)/);

  const slide = overlaysToAss([make({ ...BASE, animation: 'slide' }).overlay], frame);
  assert.match(slide, /\\move\(\d+,\d+,\d+,\d+,0,\d+\)/);
  assert.ok(!slide.includes('\\pos('), 'move заменяет pos');

  const pop = overlaysToAss([make({ ...BASE, animation: 'pop' }).overlay], frame);
  assert.match(pop, /\\fscx\d+\\fscy\d+\\t\(0,\d+,\\fscx100\\fscy100\)/);

  const none = overlaysToAss([make({ ...BASE, animation: 'none' }).overlay], frame);
  assert.match(none, /\\pos\(\d+,\d+\)/);
  assert.ok(!none.includes('\\fad('));
});

test('выравнивание задаёт код якоря ASS', () => {
  const frame = { width: 1080, height: 1920 };
  const codes = { left: 4, center: 5, right: 6 };
  for (const [align, code] of Object.entries(codes)) {
    const ass = overlaysToAss([make({ ...BASE, align }).overlay], frame);
    assert.match(ass, new RegExp(`\\\\an${code}`), `выравнивание ${align}`);
  }
});

test('несколько слоёв получают отдельные стили и события', () => {
  const overlays = [
    make({ ...BASE, text: 'Первый' }).overlay,
    make({ ...BASE, text: 'Второй', fontId: 'oswald' }, { index: 1 }).overlay,
  ];
  const ass = overlaysToAss(overlays, { width: 1080, height: 1920 });

  assert.match(ass, /^Style: Overlay0,Inter,/m);
  assert.match(ass, /^Style: Overlay1,Oswald,/m);
  assert.equal(ass.split('\n').filter((l) => l.startsWith('Dialogue:')).length, 2);
});

test('пустой список слоёв даёт валидный ASS без событий', () => {
  const ass = overlaysToAss([], { width: 720, height: 1280 });
  assert.match(ass, /\[Events\]/);
  assert.equal(ass.split('\n').filter((l) => l.startsWith('Dialogue:')).length, 0);
});
