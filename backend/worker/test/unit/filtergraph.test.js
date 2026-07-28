import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DUCKING, buildRenderCommand, escapeFilterPath, fitChain } from '../../src/filtergraph.js';
import { parseRenderPlan } from '../../src/plan.js';
import { buildTimeline } from '../../src/timeline.js';
import { fullCapabilities, makePlanDocument, makeSource } from '../helpers/fixtures.js';

const CTX = { jobId: 'job_TEST0001', projectId: 'proj_test', contractVersion: 1 };

function build(overrides = {}, opts = {}) {
  const plan = parseRenderPlan(makePlanDocument(overrides), CTX);
  const timeline = buildTimeline(plan.clips);
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
    capabilities: fullCapabilities(opts.capabilities),
    subtitlePath: opts.subtitlePath ?? null,
    fontsDir: opts.fontsDir ?? '/usr/share/fonts',
    musicInput: opts.musicInput ?? null,
    hasSpeech: opts.hasSpeech ?? true,
    outputPath: '/work/out/reel_1280p.mp4',
    preset: 'ultrafast',
  });
  return { plan, timeline, command, args: command.args, graph: command.filterComplex };
}

/** Значение флага в массиве аргументов (первое вхождение). */
function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/**
 * Значение выходного флага. `-t` и `-i` встречаются и среди входов, поэтому
 * для параметров вывода нужно последнее вхождение.
 */
function outputArgValue(args, flag) {
  const i = args.lastIndexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

test('кадрирование cover масштабирует «в накрытие» и обрезает — без растягивания', () => {
  const chain = fitChain('cover', 720, 1280);
  assert.match(chain, /force_original_aspect_ratio=increase/);
  assert.match(chain, /crop=720:1280/);
  assert.ok(!/scale=720:1280(?!:force)/.test(chain), 'прямого растягивания быть не должно');
});

test('кадрирование contain масштабирует «внутрь» и добавляет поля (§1)', () => {
  const chain = fitChain('contain', 1080, 1920);
  assert.match(chain, /force_original_aspect_ratio=decrease/);
  assert.match(chain, /pad=1080:1920:\(ow-iw\)\/2:\(oh-ih\)\/2/);
});

test('каждый клип получает свой вход и нормализуется до кадра экспорта', () => {
  const { args, graph } = build();
  assert.equal(args.filter((a) => a === '-i').length, 2);
  assert.match(graph, /\[0:v\].*crop=720:1280/);
  assert.match(graph, /\[1:v\].*crop=720:1280/);
  // Каждая видеоцепочка заканчивается yuv420p и обнулением PTS.
  assert.equal([...graph.matchAll(/format=yuv420p,setpts=PTS-STARTPTS\[v\d\]/g)].length, 2);
});

test('обрезка по таймкодам уходит во входные -ss/-t', () => {
  const { args } = build();
  // clip_1: start 0.5, end 3.5, duration 3 → берём 3.000 с с позиции 0.500.
  const ss = args.indexOf('-ss');
  assert.equal(args[ss + 1], '0.500');
  assert.equal(args[ss + 2], '-t');
  assert.equal(args[ss + 3], '3.000');
});

test('короткий исходник добирается удержанием последнего кадра', () => {
  const document = makePlanDocument();
  // На таймлайне 3 с, а в исходнике доступно только 1 с.
  document.plan.clips[0].start = 0;
  document.plan.clips[0].end = 1;
  const { graph } = build(document);
  assert.match(graph, /tpad=stop_mode=clone:stop_duration=2\.000/);
});

test('cut склеивает через concat, а не через xfade', () => {
  const document = makePlanDocument();
  document.plan.clips[1].transition = 'cut';
  const { graph } = build(document);
  assert.match(graph, /\[v0\]\[v1\]concat=n=2:v=1:a=0/);
  assert.ok(!graph.includes('xfade'), 'при cut перекрытия быть не должно');
});

test('переходы отображаются в режимы xfade по таблице контракта', () => {
  const cases = {
    fade: 'fadeblack',
    crossfade: 'fade',
    dissolve: 'fade',
    slide: 'slideleft',
    zoom: 'zoomin',
  };
  for (const [transition, mode] of Object.entries(cases)) {
    const document = makePlanDocument();
    document.plan.clips[1].transition = transition;
    const { graph } = build(document);
    assert.match(graph, new RegExp(`xfade=transition=${mode}:`), `переход ${transition}`);
  }
});

test('неизвестный сборке режим xfade откатывается на растворение', () => {
  const document = makePlanDocument();
  document.plan.clips[1].transition = 'zoom';
  const { command, graph } = build(document, {
    capabilities: { xfadeTransitions: new Set(['fade', 'fadeblack', 'slideleft']) },
  });
  assert.match(graph, /xfade=transition=fade:/);
  assert.ok(!graph.includes('zoomin'));
  assert.ok(command.notes.some((n) => n.startsWith('xfade-fallback')));
});

test('offset у xfade равен началу следующего клипа на таймлайне', () => {
  const { graph, timeline } = build();
  const offset = Number(/xfade=[^[]*offset=([\d.]+)/.exec(graph)[1]);
  assert.equal(offset, timeline.segments[1].start);
});

test('первый клип с fade получает открывающее затемнение', () => {
  const document = makePlanDocument();
  document.plan.clips[0].transition = 'fade';
  const { graph } = build(document);
  assert.match(graph, /fade=t=in:st=0:d=/);
});

test('звук склеивается зеркально видео: acrossfade там, где xfade', () => {
  const { graph, timeline } = build();
  const overlap = timeline.segments[1].overlap.toFixed(3);
  assert.match(graph, new RegExp(`acrossfade=d=${overlap.replace('.', '\\.')}`));
});

test('звук склеивается через concat там, где встык', () => {
  const document = makePlanDocument();
  document.plan.clips[1].transition = 'cut';
  const { graph } = build(document);
  assert.match(graph, /\[a0\]\[a1\]concat=n=2:v=0:a=1/);
});

test('материал без звука получает тишину нужной длины', () => {
  const { graph } = build({}, { source: { hasAudio: false } });
  assert.match(graph, /anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:3\.000/);
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
    transition: 'cut',
  };

  const { args, graph } = build(document);
  assert.ok(args.includes('-loop'), 'фото подаётся зацикленным входом');
  assert.match(graph, /zoompan=z='[^']+':x='[^']+':y='[^']+':d=1:s=720x1280:fps=30/);
});

test('без фильтра zoompan фото деградирует до статичного кадра, а не падает', () => {
  const document = makePlanDocument();
  document.assets[1] = {
    id: 'asset_b',
    type: 'photo',
    objectPath: 'projects/proj_test/sources/asset_b.jpg',
    width: 800,
    height: 600,
  };
  document.plan.clips[1] = { id: 'clip_2', mediaId: 'asset_b', type: 'photo', duration: 3, transition: 'cut' };

  const { graph } = build(document, { capabilities: { zoompan: false } });
  assert.ok(!graph.includes('zoompan'));
  assert.match(graph, /\[1:v\]scale=720:1280:force_original_aspect_ratio=increase/);
});

test('ducking использует параметры, зафиксированные §2', () => {
  const { graph } = build({}, { musicInput: { inputArgs: ['-i', 'm.m4a'], label: 'chill' } });
  assert.match(
    graph,
    new RegExp(
      `sidechaincompress=threshold=${DUCKING.threshold}:ratio=${DUCKING.ratio}` +
        `:attack=${DUCKING.attackMs}:release=${DUCKING.releaseMs}`,
    ),
  );
  assert.match(graph, /asplit=2\[voice_main\]\[voice_sc\]/, 'сайдчейн — копия голосовой шины');
  assert.match(graph, /\[mus\]\[voice_sc\]sidechaincompress/);
});

test('после loudnorm голос возвращается на 48 кГц перед даккингом (регресс §2)', () => {
  // loudnorm выдаёт 192 кГц. Если не привести голос обратно к 48 кГц, весь
  // тракт asplit→sidechaincompress→amix уходит на 192 кГц, и FFmpeg 6.1 теряет
  // ~2.9 с ведущего звука: на роликах короче ~3 с аудиопоток пропадает целиком
  // (ffmpeg завершается кодом 0, но в MP4 нет звука), а на длинных звук молча
  // усечён. Голосовая шина обязана вернуться на 48 кГц сразу за loudnorm.
  const { graph } = build({}, { musicInput: { inputArgs: ['-i', 'm.m4a'], label: 'chill' } });
  assert.match(
    graph,
    /loudnorm=I=-16:TP=-1\.5:LRA=11,aresample=48000\[vo\]/,
    'выход loudnorm должен быть ресемплирован к 48 кГц до asplit/amix',
  );
  // Ветвь даккинга питается уже приведённым к 48 кГц голосом.
  assert.match(graph, /\[vo\]asplit=2\[voice_main\]\[voice_sc\]/);
});

test('без речи ducking не включается — приглушать нечего', () => {
  const { graph } = build(
    {},
    { hasSpeech: false, musicInput: { inputArgs: ['-i', 'm.m4a'], label: 'chill' } },
  );
  assert.ok(!graph.includes('sidechaincompress'));
  assert.match(graph, /amix=inputs=2/);
});

test('громкость музыки берётся из плана', () => {
  const { graph } = build(
    { plan: { music: { volume: 0.42 } } },
    { musicInput: { inputArgs: ['-i', 'm.m4a'], label: 'chill' } },
  );
  assert.match(graph, /volume=0\.420/);
});

test('без музыки микшера нет, а голос всё равно нормализуется', () => {
  const { graph } = build();
  assert.ok(!graph.includes('amix'));
  assert.match(graph, /loudnorm=I=-16:TP=-1\.5:LRA=11/);
});

test('нормализация не применяется к дорожке без речи', () => {
  const { graph } = build({}, { hasSpeech: false });
  assert.ok(!graph.includes('loudnorm'));
});

test('мастер ограничивается лимитером и приводится к 48 кГц стерео', () => {
  const { graph } = build();
  assert.match(graph, /alimiter=limit=0\.95/);
  assert.match(graph, /aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo\[aout\]/);
});

test('субтитры вшиваются фильтром subtitles с каталогом шрифтов', () => {
  const { graph, args } = build({}, { subtitlePath: '/work/captions.ass' });
  assert.match(graph, /subtitles=filename=\/work\/captions\.ass:fontsdir=\/usr\/share\/fonts\[vsub\]/);
  assert.equal(argValue(args, '-map'), '[vsub]');
});

test('сборка без libass не вшивает субтитры, но сообщает об этом', () => {
  const { command, graph } = build(
    {},
    { subtitlePath: '/work/captions.ass', capabilities: { subtitles: false } },
  );
  assert.ok(!graph.includes('subtitles='));
  assert.ok(command.notes.some((n) => n.startsWith('subtitles-not-burned')));
});

test('путь субтитров экранируется для парсера фильтров', () => {
  assert.equal(escapeFilterPath('C:/tmp/a:b.ass'), 'C\\:/tmp/a\\:b.ass');
  assert.equal(escapeFilterPath("/tmp/it's,here.ass"), "/tmp/it\\'s\\,here.ass");
});

test('параметры кодека соответствуют таблице §1 для выбранного разрешения', () => {
  const { args } = build({ export: { resolution: 'fullHd1080', fps: 60 } });
  assert.equal(argValue(args, '-c:v'), 'libx264');
  assert.equal(argValue(args, '-profile:v'), 'high');
  assert.equal(argValue(args, '-level:v'), '42');
  assert.equal(argValue(args, '-pix_fmt'), 'yuv420p');
  assert.equal(argValue(args, '-b:v'), '8000k');
  assert.equal(argValue(args, '-maxrate'), '10000k');
  assert.equal(argValue(args, '-bufsize'), '20000k');
  assert.equal(argValue(args, '-c:a'), 'aac');
  assert.equal(argValue(args, '-b:a'), '160k');
  assert.equal(argValue(args, '-ar'), '48000');
  assert.equal(argValue(args, '-ac'), '2');
});

test('GOP равен удвоенной частоте кадров (§1)', () => {
  for (const [fps, gop] of [
    [30, '60'],
    [60, '120'],
  ]) {
    const { args } = build({ export: { fps } });
    assert.equal(argValue(args, '-g'), gop);
    assert.equal(argValue(args, '-keyint_min'), String(fps));
    assert.equal(argValue(args, '-r'), String(fps));
  }
});

test('контейнер mp4 собирается с faststart', () => {
  const { args } = build();
  assert.equal(argValue(args, '-movflags'), '+faststart');
});

test('длительность вывода равна длине таймлайна с учётом перекрытий', () => {
  const { args, timeline, command } = build();
  assert.equal(outputArgValue(args, '-t'), timeline.totalDuration.toFixed(3));
  assert.equal(command.expectedDuration, timeline.totalDuration);
});

test('метаданные исходников не переносятся в результат', () => {
  const { args } = build();
  assert.equal(argValue(args, '-map_metadata'), '-1');
});

test('версионно-хрупкий флаг autorotate не передаётся', () => {
  // В FFmpeg ≤ 6 опция требовала значение, в 7+ это флаг без аргумента:
  // лишний «1» уезжает в имя выходного файла и ломает запуск. Автоповорот
  // включён по умолчанию, поэтому флаг не нужен.
  const { args } = build();
  assert.ok(!args.includes('-autorotate'));
  assert.ok(!args.includes('-noautorotate'), 'отключать автоповорот тоже нельзя');
});

test('прогресс запрашивается в машиночитаемом виде', () => {
  const { args } = build();
  assert.equal(argValue(args, '-progress'), 'pipe:1');
  assert.ok(args.includes('-nostats'));
});

test('все четыре разрешения §1 дают корректный кадр и битрейт', () => {
  const expected = {
    hd720: { size: [720, 1280], bitrate: '4000k', audio: '128k', level: '40' },
    fullHd1080: { size: [1080, 1920], bitrate: '8000k', audio: '160k', level: '42' },
    twoK1440: { size: [1440, 2560], bitrate: '16000k', audio: '192k', level: '50' },
    fourK2160: { size: [2160, 3840], bitrate: '35000k', audio: '192k', level: '51' },
  };

  for (const [resolution, want] of Object.entries(expected)) {
    const { args, graph } = build({ export: { resolution } });
    assert.equal(argValue(args, '-b:v'), want.bitrate, resolution);
    assert.equal(argValue(args, '-b:a'), want.audio, resolution);
    assert.equal(argValue(args, '-level:v'), want.level, resolution);
    assert.match(graph, new RegExp(`crop=${want.size[0]}:${want.size[1]}`), resolution);
  }
});
