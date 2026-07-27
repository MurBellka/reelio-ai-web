import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RESOLUTIONS } from '../../src/contract.js';
import { buildRenderCommand, escapeFilterPath, fitChain } from '../../src/filtergraph.js';
import { parseRenderPlan } from '../../src/plan.js';
import { buildTimeline } from '../../src/timeline.js';
import { TRANSITION_CATALOG, buildVerifiedCatalog } from '../../src/transitions.js';
import { ALL_XFADE_MODES, fullCapabilities, makePlanDocument, makeSource } from '../helpers/fixtures.js';

const CTX = {
  jobId: 'job_TEST0001',
  projectId: 'proj_test',
  projectPrefix: 'projects/proj_test/',
  contractVersion: 2,
};

function build(overrides = {}, opts = {}) {
  const plan = parseRenderPlan(makePlanDocument(overrides), CTX);
  const timeline = buildTimeline(plan.clips);
  const capabilities = fullCapabilities(opts.capabilities);
  const sources = new Map(
    plan.assets.map((a) => [
      a.id,
      makeSource({ assetId: a.id, filePath: `/work/${a.id}.mp4`, ...(opts.source ?? {}) }),
    ]),
  );

  const command = buildRenderCommand({
    plan,
    timeline,
    sources,
    fitMode: opts.fitMode ?? 'cover',
    capabilities,
    verifiedCatalog: opts.verifiedCatalog ?? buildVerifiedCatalog(capabilities.xfadeTransitions),
    subtitlePath: opts.subtitlePath ?? null,
    overlayPath: opts.overlayPath ?? null,
    fontsDir: opts.fontsDir ?? '/opt/reelio/fonts',
    outputPath: '/work/out/reel_1280p.mp4',
    preset: 'ultrafast',
  });

  return { plan, timeline, command, args: command.args, graph: command.filterComplex };
}

const argValue = (args, flag) => (args.indexOf(flag) >= 0 ? args[args.indexOf(flag) + 1] : undefined);
const outputArgValue = (args, flag) =>
  args.lastIndexOf(flag) >= 0 ? args[args.lastIndexOf(flag) + 1] : undefined;

// ── Кадрирование ──────────────────────────────────────────────────────────

test('cover масштабирует «в накрытие» и обрезает — без растягивания', () => {
  const chain = fitChain('cover', 720, 1280);
  assert.match(chain, /force_original_aspect_ratio=increase/);
  assert.match(chain, /crop=720:1280/);
  assert.ok(!/scale=720:1280(?!:force)/.test(chain));
});

test('contain масштабирует «внутрь» и добавляет поля', () => {
  const chain = fitChain('contain', 1080, 1920);
  assert.match(chain, /force_original_aspect_ratio=decrease/);
  assert.match(chain, /pad=1080:1920/);
});

// ── Переходы (§2) ─────────────────────────────────────────────────────────

test('каждый переход каталога попадает в граф своим режимом xfade', () => {
  for (const [type, entry] of Object.entries(TRANSITION_CATALOG)) {
    if (type === 'cut') continue;

    const document = makePlanDocument();
    document.plan.clips[1].transition = { type, durationSeconds: 0.4 };
    const { graph } = build(document);

    assert.match(
      graph,
      new RegExp(`xfade=transition=${entry.xfade}:duration=0\\.400`),
      `переход ${type} → ${entry.xfade}`,
    );
  }
});

test('cut склеивает через concat, xfade не появляется', () => {
  const document = makePlanDocument();
  document.plan.clips[1].transition = { type: 'cut' };
  const { graph } = build(document);

  assert.match(graph, /\[v0\]\[v1\]concat=n=2:v=1:a=0/);
  assert.ok(!graph.includes('xfade'));
});

test('offset у xfade равен началу следующего клипа на таймлайне', () => {
  const { graph, timeline } = build();
  const offset = Number(/xfade=[^[]*offset=([\d.]+)/.exec(graph)[1]);
  assert.equal(offset, timeline.segments[1].start);
});

test('переход вне проверенного каталога откатывается на растворение', () => {
  const document = makePlanDocument();
  document.plan.clips[1].transition = { type: 'pixelize', durationSeconds: 0.4 };

  const { command, graph } = build(document, {
    verifiedCatalog: buildVerifiedCatalog(new Set(['fade', 'fadeblack'])),
  });

  assert.match(graph, /xfade=transition=fade:/);
  assert.ok(!graph.includes('pixelize'));
  assert.ok(command.notes.some((n) => n.startsWith('transition-fallback:')));
});

test('первый клип с затемнением получает открывающий fade', () => {
  const document = makePlanDocument();
  document.plan.clips[0].transition = { type: 'fadeBlack' };
  assert.match(build(document).graph, /fade=t=in:st=0:d=/);
});

// ── Звук (§1 v2) ──────────────────────────────────────────────────────────

test('keepOriginal: true — в выводе есть дорожка AAC', () => {
  const { args, command, graph } = build();

  assert.equal(command.hasAudio, true);
  assert.equal(argValue(args, '-c:a'), 'aac');
  assert.equal(argValue(args, '-ar'), '48000');
  assert.ok(!args.includes('-an'));
  assert.match(graph, /\[aout\]/);
});

test('keepOriginal: false — вывод без звука и с явным -an', () => {
  const { args, command, graph } = build({ plan: { audio: { keepOriginal: false } } });

  assert.equal(command.hasAudio, false);
  assert.ok(args.includes('-an'), 'без -an FFmpeg подтянул бы дорожку входа');
  assert.equal(argValue(args, '-c:a'), undefined);
  assert.equal(argValue(args, '-b:a'), undefined);
  assert.ok(!graph.includes('aout'));
  assert.ok(!graph.includes('[0:a]'));
});

test('материалы без звука дают ролик без дорожки', () => {
  const { args, command } = build({}, { source: { hasAudio: false } });
  assert.equal(command.hasAudio, false);
  assert.ok(args.includes('-an'));
  assert.ok(command.notes.some((n) => n.startsWith('audio-omitted:')));
});

test('музыкальных фильтров в графе нет ни в одном режиме', () => {
  for (const keepOriginal of [true, false]) {
    const { graph } = build({ plan: { audio: { keepOriginal } } });
    for (const forbidden of ['amix', 'sidechaincompress', 'aevalsrc', 'volume=']) {
      assert.ok(!graph.includes(forbidden), `keepOriginal=${keepOriginal}: найден ${forbidden}`);
    }
  }
});

// ── Текст и субтитры (§4, §6) ─────────────────────────────────────────────

test('субтитры и текстовые слои вшиваются двумя фильтрами subtitles', () => {
  const { args, graph } = build(
    {},
    { subtitlePath: '/work/captions.ass', overlayPath: '/work/overlays.ass' },
  );

  assert.match(graph, /subtitles=filename=\/work\/captions\.ass:fontsdir=\/opt\/reelio\/fonts\[vsub\]/);
  assert.match(graph, /\[vsub\]subtitles=filename=\/work\/overlays\.ass/);
  assert.equal(argValue(args, '-map'), '[vtext]');
});

test('только текстовые слои без субтитров тоже работают', () => {
  const { args, graph } = build({}, { overlayPath: '/work/overlays.ass' });
  assert.match(graph, /\[vc1\]subtitles=filename=\/work\/overlays\.ass:fontsdir=[^[]+\[vtext\]/);
  assert.equal(argValue(args, '-map'), '[vtext]');
});

test('сборка без libass не вшивает текст, но сообщает об этом', () => {
  const { command, graph } = build(
    {},
    {
      subtitlePath: '/work/captions.ass',
      overlayPath: '/work/overlays.ass',
      capabilities: { subtitles: false },
    },
  );

  assert.ok(!graph.includes('subtitles='));
  assert.equal(command.notes.filter((n) => n.includes('not-burned')).length, 2);
});

test('§4.3: в filter_complex попадают только пути, не текст пользователя', () => {
  const document = makePlanDocument({
    plan: {
      captions: { sampleText: 'цена: 500 руб, скидка [50%]' },
      textOverlays: [{ text: "a:b,c;d'e", startSeconds: 0, endSeconds: 2 }],
    },
  });
  const { graph } = build(document, { overlayPath: '/work/overlays.ass' });

  assert.ok(!graph.includes('скидка'), 'текст субтитров не должен быть в графе');
  assert.ok(!graph.includes('a:b,c'), 'текст слоя не должен быть в графе');
});

test('пути к файлам экранируются для парсера фильтров', () => {
  assert.equal(escapeFilterPath('C:/tmp/a:b.ass'), 'C\\:/tmp/a\\:b.ass');
  assert.equal(escapeFilterPath("/tmp/it's,here.ass"), "/tmp/it\\'s\\,here.ass");
});

// ── Кодек и контейнер ─────────────────────────────────────────────────────

test('параметры кодека соответствуют таблице §1', () => {
  const { args } = build({ export: { resolution: 'fullHd1080', fps: 60 } });

  assert.equal(argValue(args, '-c:v'), 'libx264');
  assert.equal(argValue(args, '-profile:v'), 'high');
  assert.equal(argValue(args, '-level:v'), '42');
  assert.equal(argValue(args, '-pix_fmt'), 'yuv420p');
  assert.equal(argValue(args, '-b:v'), '8000k');
  assert.equal(argValue(args, '-maxrate'), '10000k');
  assert.equal(argValue(args, '-g'), '120');
  assert.equal(argValue(args, '-b:a'), '160k');
});

test('все четыре разрешения §1 дают корректный кадр и битрейт', () => {
  const expected = {
    hd720: { bitrate: '4000k', level: '40' },
    fullHd1080: { bitrate: '8000k', level: '42' },
    twoK1440: { bitrate: '16000k', level: '50' },
    fourK2160: { bitrate: '35000k', level: '51' },
  };

  for (const [resolution, want] of Object.entries(expected)) {
    const { args, graph } = build({ export: { resolution } });
    const { width, height } = RESOLUTIONS[resolution];

    assert.equal(argValue(args, '-b:v'), want.bitrate, resolution);
    assert.equal(argValue(args, '-level:v'), want.level, resolution);
    assert.match(graph, new RegExp(`crop=${width}:${height}`), resolution);
  }
});

test('пресет Instagram Reels даёт 1080×1920 при 30 кадрах', () => {
  const { args, graph } = build({ export: { preset: 'instagramReels' } });
  assert.equal(argValue(args, '-r'), '30');
  assert.equal(argValue(args, '-b:v'), '8000k');
  assert.match(graph, /crop=1080:1920/);
});

test('контейнер mp4 собирается с faststart', () => {
  assert.equal(argValue(build().args, '-movflags'), '+faststart');
});

test('длительность вывода равна длине таймлайна с учётом перекрытий', () => {
  const { args, timeline, command } = build();
  assert.equal(outputArgValue(args, '-t'), timeline.totalDuration.toFixed(3));
  assert.equal(command.expectedDuration, timeline.totalDuration);
});

test('метаданные исходников не переносятся в результат', () => {
  assert.equal(argValue(build().args, '-map_metadata'), '-1');
});

test('версионно-хрупкий флаг autorotate не передаётся', () => {
  const { args } = build();
  assert.ok(!args.includes('-autorotate'));
  assert.ok(!args.includes('-noautorotate'));
});

test('фото превращается в клип с движением pan/zoom', () => {
  const document = makePlanDocument();
  document.assets[1] = {
    id: 'asset_b',
    type: 'photo',
    objectPath: 'projects/proj_test/sources/asset_b.jpg',
    width: 800,
    height: 600,
  };
  document.plan.clips[1] = {
    id: 'clip_2',
    mediaId: 'asset_b',
    type: 'photo',
    duration: 3,
    transition: { type: 'cut' },
  };

  const { args, graph } = build(document);
  assert.ok(args.includes('-loop'));
  assert.match(graph, /zoompan=z='[^']+':x='[^']+':y='[^']+':d=1:s=720x1280:fps=30/);
});

test('пометки таймлайна доходят до результата сборки команды', () => {
  const document = makePlanDocument();
  document.plan.clips[1].duration = 0.3;
  document.plan.clips[1].end = 0.4;
  document.plan.clips[1].transition = { type: 'dissolve' };

  const { command } = build(document);
  assert.ok(command.notes.some((n) => n.startsWith('transition-degraded:')));
});

test('полный каталог опирается только на режимы, которые есть в сборке', () => {
  const catalog = buildVerifiedCatalog(ALL_XFADE_MODES);
  for (const type of catalog.types) {
    if (type === 'cut') continue;
    assert.ok(ALL_XFADE_MODES.has(TRANSITION_CATALOG[type].xfade), type);
  }
});
