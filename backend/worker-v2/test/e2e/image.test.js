// Проверка того, что уедет в Docker-образ reelio-ffmpeg-worker-v2.
//
// Полноценный `docker build` требует контейнерного рантайма, которого может не
// быть на машине разработчика. Но главный риск образа проверяется и без него:
// COPY тащит только package.json, src/ и assets/fonts/, и если какой-то модуль
// на самом деле подтягивается со стороны, контейнер упадёт уже в проде. Здесь
// дерево образа собирается на диске по правилам Dockerfile, и worker
// запускается из него как настоящая программа.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { promisify } from 'node:util';

import { FONT_CATALOG } from '../../src/fonts.js';
import { REPO_ROOT, ffmpegAvailable, makePlanDocument, makeVideo, tempDir } from '../helpers/fixtures.js';

const execFileAsync = promisify(execFile);
const WORKER_ROOT = path.join(REPO_ROOT, 'backend/worker-v2');
const DOCKERFILE = await readFile(path.join(WORKER_ROOT, 'Dockerfile'), 'utf8');

/** Инструкции Dockerfile в виде [INSTRUCTION, аргументы]. */
function dockerInstructions(text) {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  const merged = [];
  let buffer = '';
  for (const line of lines) {
    buffer += buffer ? ` ${line}` : line;
    if (line.endsWith('\\')) {
      buffer = buffer.slice(0, -1).trim();
      continue;
    }
    merged.push(buffer);
    buffer = '';
  }
  if (buffer) merged.push(buffer);

  return merged.map((line) => {
    const at = line.indexOf(' ');
    return [line.slice(0, at).toUpperCase(), line.slice(at + 1).trim()];
  });
}

describe('содержимое Docker-образа v2', () => {
  const instructions = dockerInstructions(DOCKERFILE);
  const byName = (name) => instructions.filter(([i]) => i === name).map(([, args]) => args);

  test('Dockerfile начинается с FROM и задаёт ENTRYPOINT', () => {
    assert.equal(instructions[0][0], 'FROM');
    assert.equal(byName('ENTRYPOINT').length, 1);
    assert.match(byName('ENTRYPOINT')[0], /node.*src\/index\.js/);
  });

  test('образ ставит ffmpeg и fontconfig', () => {
    const run = byName('RUN').join('\n');
    assert.match(run, /\bffmpeg\b/);
    assert.match(run, /fontconfig/, 'libass ищет шрифты через fontconfig');
    assert.match(run, /rm -rf \/var\/lib\/apt\/lists/);
  });

  test('COPY рассчитан на контекст из корня репозитория', () => {
    const copies = byName('COPY');
    assert.ok(copies.some((c) => c.startsWith('backend/worker-v2/package.json')));
    assert.ok(copies.some((c) => c.startsWith('backend/worker-v2/src/')));
    assert.ok(copies.some((c) => c.startsWith('assets/fonts/')), 'шрифты §5 обязаны попасть в образ');
  });

  test('каталог шрифтов из ENV совпадает с тем, куда их копирует COPY', () => {
    const env = byName('ENV').join(' ');
    const target = /assets\/fonts\/\s+(\S+)/.exec(byName('COPY').find((c) => c.startsWith('assets/fonts/')))[1];
    assert.match(env, new RegExp(`REELIO_FONTS_DIR=${target.replace(/\/$/, '')}`));
  });

  test('музыкальный каталог из образа убран', () => {
    assert.ok(!DOCKERFILE.includes('REELIO_MUSIC_DIR'));
    assert.ok(!DOCKERFILE.includes('/opt/reelio/music'));
  });

  test('процесс работает не от root', () => {
    assert.equal(byName('USER').at(-1), 'worker');
    assert.match(byName('RUN').join('\n'), /useradd/);
  });

  test('.dockerignore исключает тесты из контекста сборки', async () => {
    const ignore = await readFile(path.join(WORKER_ROOT, '.dockerignore'), 'utf8');
    assert.match(ignore, /^test\/$/m);
    assert.match(ignore, /^node_modules\/$/m);
  });

  test('в package.json нет внешних зависимостей — образ не требует npm install', async () => {
    const pkg = JSON.parse(await readFile(path.join(WORKER_ROOT, 'package.json'), 'utf8'));
    assert.deepEqual(pkg.dependencies ?? {}, {});
    assert.equal(pkg.type, 'module');
  });

  test('ни один модуль src/ не импортирует ничего за пределами src/', async () => {
    const files = (await readdir(path.join(WORKER_ROOT, 'src'))).filter((f) => f.endsWith('.js'));
    assert.ok(files.length > 0);

    for (const file of files) {
      const source = await readFile(path.join(WORKER_ROOT, 'src', file), 'utf8');
      for (const match of source.matchAll(/from\s+'([^']+)'/g)) {
        const specifier = match[1];
        if (specifier.startsWith('node:')) continue;
        assert.ok(
          specifier.startsWith('./'),
          `${file}: импорт «${specifier}» уводит за пределы src/ и не попадёт в образ`,
        );
      }
    }
  });

  test('модуля музыки в образе не осталось', async () => {
    const files = await readdir(path.join(WORKER_ROOT, 'src'));
    assert.ok(!files.includes('music.js'));

    for (const file of files) {
      const source = await readFile(path.join(WORKER_ROOT, 'src', file), 'utf8');
      assert.ok(!source.includes('resolveMusicInput'), `${file}: остался вызов музыки`);
      assert.ok(!source.includes('sidechaincompress'), `${file}: остался ducking`);
    }
  });
});

const available = await ffmpegAvailable();

describe('запуск из дерева образа', { skip: available ? false : 'ffmpeg недоступен' }, () => {
  test('worker собирает ролик, имея только package.json, src/ и шрифты', { timeout: 300_000 }, async () => {
    // ── Воспроизводим COPY из Dockerfile ────────────────────────────────
    const image = await tempDir('reelio-image-v2-');
    const app = path.join(image, 'app');
    const fonts = path.join(image, 'opt/reelio/fonts');
    await mkdir(app, { recursive: true });
    await cp(path.join(WORKER_ROOT, 'package.json'), path.join(app, 'package.json'));
    await cp(path.join(WORKER_ROOT, 'src'), path.join(app, 'src'), { recursive: true });
    await cp(path.join(REPO_ROOT, 'assets/fonts'), fonts, { recursive: true });

    // Шрифты каталога обязаны оказаться в образе.
    const copied = new Set(await readdir(fonts));
    for (const entry of Object.values(FONT_CATALOG)) {
      assert.ok(copied.has(entry.files.regular), `в образе нет ${entry.files.regular}`);
    }

    // ── Готовим задачу в local mode ─────────────────────────────────────
    const root = path.join(image, 'render-local');
    const projectId = 'proj_img';
    const jobId = 'job_img0001';
    const prefix = `projects/${projectId}/`;
    const sourcesDir = path.join(root, `${prefix}sources`);
    await mkdir(sourcesDir, { recursive: true });
    await makeVideo(path.join(sourcesDir, 'asset_a.mp4'), { duration: 2, width: 320, height: 240 });
    await makeVideo(path.join(sourcesDir, 'asset_b.mp4'), { duration: 2, width: 240, height: 320 });

    const document = makePlanDocument({ jobId, projectId });
    for (const asset of document.assets) {
      asset.objectPath = `${prefix}sources/${asset.id}.mp4`;
      asset.durationSeconds = 2;
    }
    for (const clip of document.plan.clips) {
      clip.duration = 1.5;
      clip.start = 0;
      clip.end = 1.5;
    }
    document.plan.textOverlays = [
      { id: 't', text: 'Привет', startSeconds: 0.2, endSeconds: 1.2, position: { anchor: 'center' } },
    ];

    const planPath = path.join(root, `${prefix}jobs/${jobId}/plan.json`);
    await mkdir(path.dirname(planPath), { recursive: true });
    await writeFile(planPath, JSON.stringify(document));

    // ── Запускаем ровно так, как это сделает ENTRYPOINT ─────────────────
    const { stdout } = await execFileAsync(process.execPath, ['src/index.js'], {
      cwd: app,
      env: {
        PATH: process.env.PATH,
        HOME: image,
        NODE_ENV: 'production',
        REELIO_JOB_ID: jobId,
        REELIO_PROJECT_ID: projectId,
        REELIO_PROJECT_PREFIX: prefix,
        REELIO_JOB_PREFIX: `${prefix}jobs/${jobId}/`,
        REELIO_PLAN_URI: `file://${planPath}`,
        REELIO_OUTPUT_PREFIX: `${prefix}jobs/${jobId}/output`,
        REELIO_CONTRACT_VERSION: '2',
        REELIO_WORK_DIR: path.join(image, 'work'),
        REELIO_FONTS_DIR: fonts,
        REELIO_X264_PRESET: 'ultrafast',
      },
      maxBuffer: 8 * 1024 * 1024,
    });

    const entries = stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.ok(entries.some((e) => e.message === 'job succeeded'), stdout);

    const output = await readFile(path.join(root, `${prefix}jobs/${jobId}/output/reel_1280p.mp4`));
    assert.ok(output.length > 1000);
  });
});
