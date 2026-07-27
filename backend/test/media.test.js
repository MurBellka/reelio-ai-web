// Проверка загруженных файлов по содержимому.
//
// Файлы здесь настоящие — генерируются ffmpeg'ом. Смысл в том, чтобы поймать
// подмену: клиент может назвать что угодно как угодно, решает только ffprobe.
//
// Если ffmpeg в системе отсутствует, набор пропускается: это проверка
// интеграции с реальным декодером, а не заглушкой.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { before, after, describe, it } from 'node:test';

import { inspectAsset, validateProjectMedia } from '../src/media-validation.js';
import { ApiError } from '../src/errors.js';

const exec = promisify(execFile);

const LIMITS = {
  maxVideos: 20,
  maxPhotos: 20,
  maxSingleVideoSeconds: 5,
  maxProjectVideoSeconds: 8,
  maxProjectBytes: 5 * 1024 * 1024,
};

let hasFfmpeg = false;
let dir;

before(async () => {
  try {
    await exec('ffprobe', ['-version']);
    await exec('ffmpeg', ['-version']);
    hasFfmpeg = true;
  } catch {
    hasFfmpeg = false;
  }
  dir = await mkdtemp(join(tmpdir(), 'reelio-media-'));
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function makeVideo(name, seconds, size = '320x568') {
  const path = join(dir, name);
  await exec('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=15:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    path,
  ]);
  return path;
}

async function makeImage(name) {
  const path = join(dir, name);
  await exec('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x568:rate=1:duration=1',
    '-frames:v', '1', path,
  ]);
  return path;
}

/** Хранилище-заглушка: signedReadUrl отдаёт локальный путь, ffprobe его читает. */
function fakeStorage(files) {
  const deleted = [];
  return {
    deleted,
    async signedReadUrl(objectPath) {
      return { url: files[objectPath], expiresAt: new Date(Date.now() + 60000).toISOString() };
    },
    async deleteObject(objectPath) {
      deleted.push(objectPath);
    },
  };
}

describe('проверка содержимого материалов', () => {
  it('распознаёт настоящее видео и его параметры', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg недоступен');
    const path = await makeVideo('ok.mp4', 2);
    const info = await inspectAsset({
      url: path,
      declaredType: 'video',
      limits: LIMITS,
      ffprobePath: 'ffprobe',
    });
    assert.equal(info.type, 'video');
    assert.equal(info.videoCodec, 'h264');
    assert.equal(info.width, 320);
    assert.equal(info.height, 568);
    assert.ok(info.durationSeconds > 1.5 && info.durationSeconds < 2.5);
    assert.ok(info.sizeBytes > 0);
  });

  it('распознаёт изображение', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg недоступен');
    const path = await makeImage('ok.jpg');
    const info = await inspectAsset({
      url: path,
      declaredType: 'photo',
      limits: LIMITS,
      ffprobePath: 'ffprobe',
    });
    assert.equal(info.type, 'photo');
    assert.equal(info.durationSeconds, null);
  });

  it('текстовый файл с расширением .mp4 отклоняется', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg недоступен');
    // Ровно та подмена, от которой не спасают ни расширение, ни Content-Type.
    const path = join(dir, 'fake.mp4');
    await writeFile(path, 'это вообще не видео, а текст');

    await assert.rejects(
      inspectAsset({ url: path, declaredType: 'video', limits: LIMITS, ffprobePath: 'ffprobe' }),
      (e) => e instanceof ApiError && e.code === 'MEDIA_INVALID',
    );
  });

  it('видео длиннее лимита отклоняется', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg недоступен');
    const path = await makeVideo('long.mp4', 7); // лимит 5 с
    await assert.rejects(
      inspectAsset({ url: path, declaredType: 'video', limits: LIMITS, ffprobePath: 'ffprobe' }),
      (e) => e instanceof ApiError && e.code === 'MEDIA_TOO_LONG',
    );
  });

  it('видео, названное фотографией, всё равно считается видео', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg недоступен');
    const path = await makeVideo('sneaky.mp4', 7);
    // Клиент объявил photo, чтобы обойти лимит длительности видео.
    await assert.rejects(
      inspectAsset({ url: path, declaredType: 'photo', limits: LIMITS, ffprobePath: 'ffprobe' }),
      (e) => e instanceof ApiError && e.code === 'MEDIA_TOO_LONG',
      'фактический тип определяет ffprobe, а не клиент',
    );
  });

  it('непригодный файл удаляется из хранилища сразу', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg недоступен');
    const bad = join(dir, 'broken.mp4');
    await writeFile(bad, 'мусор');
    const storage = fakeStorage({ 'users/u/projects/p/sources/a.mp4': bad });

    await assert.rejects(
      validateProjectMedia({
        assets: [{ id: 'a', type: 'video', objectPath: 'users/u/projects/p/sources/a.mp4' }],
        storage,
        limits: LIMITS,
        ffprobePath: 'ffprobe',
      }),
      (e) => e instanceof ApiError,
    );
    assert.deepEqual(storage.deleted, ['users/u/projects/p/sources/a.mp4']);
  });

  it('суммарная длительность проекта ограничена', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg недоступен');
    // По отдельности оба видео допустимы (по 4 с при лимите 5), вместе — нет.
    const a = await makeVideo('sum_a.mp4', 4);
    const b = await makeVideo('sum_b.mp4', 4);
    const files = {
      'users/u/projects/p/sources/a.mp4': a,
      'users/u/projects/p/sources/b.mp4': b,
    };
    await assert.rejects(
      validateProjectMedia({
        assets: [
          { id: 'a', type: 'video', objectPath: 'users/u/projects/p/sources/a.mp4' },
          { id: 'b', type: 'video', objectPath: 'users/u/projects/p/sources/b.mp4' },
        ],
        storage: fakeStorage(files),
        // По отдельности 4 с проходят (лимит 5), суммарные 8 с — нет.
        limits: { ...LIMITS, maxProjectVideoSeconds: 6 },
        ffprobePath: 'ffprobe',
      }),
      (e) => e instanceof ApiError && e.code === 'MEDIA_TOO_LONG',
    );
  });

  it('проверка не удаляет исходный файл пользователя', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg недоступен');
    // В local mode downloadToTemp отдаёт путь к НАСТОЯЩЕМУ файлу, а не копию.
    // Если пометка владения потеряется, успешная проверка сотрёт исходник.
    const path = await makeVideo('keep.mp4', 2);
    const storage = {
      ...fakeStorage({ 'users/u/projects/p/sources/a.mp4': path }),
      async downloadToTemp() {
        return { path, temporary: false };
      },
    };

    const result = await validateProjectMedia({
      assets: [{ id: 'a', type: 'video', objectPath: 'users/u/projects/p/sources/a.mp4' }],
      storage,
      limits: LIMITS,
      ffprobePath: 'ffprobe',
    });

    assert.equal(result.byAssetId.a.type, 'video');
    await assert.doesNotReject(stat(path), 'исходник обязан остаться на месте');
  });

  it('временная копия удаляется после проверки', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg недоступен');
    const source = await makeVideo('copy_src.mp4', 2);
    const copy = join(dir, 'temp_copy.mp4');
    await copyFile(source, copy);
    const storage = {
      ...fakeStorage({}),
      async downloadToTemp() {
        return { path: copy, temporary: true };
      },
    };

    await validateProjectMedia({
      assets: [{ id: 'a', type: 'video', objectPath: 'users/u/projects/p/sources/a.mp4' }],
      storage,
      limits: LIMITS,
      ffprobePath: 'ffprobe',
    });

    await assert.rejects(stat(copy), 'временная копия не должна оставаться');
  });

  it('слишком много файлов отклоняется до чтения', async () => {
    const assets = Array.from({ length: 21 }, (_, i) => ({
      id: `v${i}`,
      type: 'video',
      objectPath: `users/u/projects/p/sources/v${i}.mp4`,
    }));
    await assert.rejects(
      validateProjectMedia({ assets, storage: fakeStorage({}), limits: LIMITS, ffprobePath: 'ffprobe' }),
      (e) => e instanceof ApiError && e.code === 'MEDIA_INVALID',
    );
  });

  it('общий размер проекта ограничен', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg недоступен');
    const big = await makeVideo('big.mp4', 3, '1080x1920');
    await assert.rejects(
      validateProjectMedia({
        assets: [{ id: 'a', type: 'video', objectPath: 'users/u/projects/p/sources/a.mp4' }],
        storage: fakeStorage({ 'users/u/projects/p/sources/a.mp4': big }),
        limits: { ...LIMITS, maxProjectBytes: 1024, maxSingleVideoSeconds: 60 },
        ffprobePath: 'ffprobe',
      }),
      (e) => e instanceof ApiError && e.code === 'PROJECT_TOO_LARGE',
    );
  });
});

// ── Расположение метаданных и крупные файлы ────────────────────────────────
//
// ffmpeg по умолчанию пишет moov в КОНЕЦ файла. Если проверка видит только
// начало, такое видео выглядит повреждённым — и корректный пользовательский
// файл получает отказ. Эти тесты фиксируют и проблему, и её решение.

/** Смещение атома moov в MP4 и общий размер файла. */
async function moovOffset(path) {
  const { readFile } = await import('node:fs/promises');
  const buf = await readFile(path);
  let i = 0;
  while (i < buf.length - 8) {
    const size = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    if (type === 'moov') return { offset: i, total: buf.length };
    if (size < 8) break;
    i += size;
  }
  return { offset: -1, total: buf.length };
}

async function makeFaststart(src, name) {
  const out = join(dir, name);
  await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', src,
    '-c', 'copy', '-movflags', '+faststart', out]);
  return out;
}

describe('расположение метаданных в MP4', () => {
  it('ffmpeg по умолчанию кладёт moov в конец', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg недоступен');
    const path = await makeVideo('moov_tail.mp4', 4);
    const { offset, total } = await moovOffset(path);
    assert.ok(offset > 0, 'moov должен найтись');
    assert.ok(offset > total / 2, `moov на ${offset} из ${total} — ожидался конец файла`);
  });

  it('faststart переносит moov в начало', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg недоступен');
    const src = await makeVideo('ms_src.mp4', 4);
    const fast = await makeFaststart(src, 'moov_head.mp4');
    const { offset, total } = await moovOffset(fast);
    assert.ok(offset < total / 10, `moov на ${offset} из ${total} — ожидалось начало`);
  });

  it('оба варианта распознаются при полном доступе к файлу', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg недоступен');
    // Полный доступ — это то, что даёт FUSE-монтирование в облаке.
    const tail = await makeVideo('full_tail.mp4', 4);
    const head = await makeFaststart(tail, 'full_head.mp4');

    for (const [name, path] of [['moov в конце', tail], ['moov в начале', head]]) {
      const info = await inspectAsset({
        localPath: path,
        declaredType: 'video',
        limits: { ...LIMITS, maxSingleVideoSeconds: 60 },
        ffprobePath: 'ffprobe',
      });
      assert.equal(info.type, 'video', name);
      assert.equal(info.videoCodec, 'h264', name);
      assert.ok(info.durationSeconds > 3 && info.durationSeconds < 5, name);
    }
  });

  it('усечённая копия ломает файл с moov в конце — почему нужен полный доступ', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg недоступен');
    const { readFile, writeFile: wf } = await import('node:fs/promises');
    const full = await makeVideo('trunc_src.mp4', 20, '640x360');
    const whole = await readFile(full);
    assert.ok(whole.length > 200 * 1024, 'исходник должен быть заметно больше усечения');
    const head = whole.subarray(0, 64 * 1024);
    const cut = join(dir, 'trunc_head_only.mp4');
    await wf(cut, head);

    await assert.rejects(
      inspectAsset({
        localPath: cut,
        declaredType: 'video',
        limits: { ...LIMITS, maxSingleVideoSeconds: 60 },
        ffprobePath: 'ffprobe',
      }),
      (e) => e instanceof ApiError && e.code === 'MEDIA_INVALID',
      'обрезанный файл с moov в конце обязан не читаться — это и есть причина, '
        + 'по которой в облаке требуется монтирование бакета',
    );
  });
});

describe('крупные и длинные видео', () => {
  it('видео больше 24 МБ проходит проверку целиком', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg недоступен');
    // 24 МБ — прежний лимит частичного скачивания. Файл заведомо больше.
    const path = join(dir, 'big.mp4');
    // Синтетический testsrc сжимается почти в ничто, поэтому берём шум и
    // кодируем без потерь — иначе до 24 МБ файл не дорастёт.
    await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'nullsrc=size=1280x720:rate=30:duration=12,geq=random(1)*255:128:128',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-qp', '0', '-preset', 'ultrafast',
      '-c:a', 'aac', '-shortest', path], { maxBuffer: 8 * 1024 * 1024 });

    const { size } = await stat(path);
    assert.ok(size > 24 * 1024 * 1024, `файл ${Math.round(size / 1048576)} МБ должен быть > 24 МБ`);

    const info = await inspectAsset({
      localPath: path,
      declaredType: 'video',
      limits: { ...LIMITS, maxSingleVideoSeconds: 60, maxProjectBytes: 500 * 1024 * 1024 },
      ffprobePath: 'ffprobe',
    });
    assert.equal(info.width, 1280);
    assert.equal(info.height, 720);
    assert.ok(info.sizeBytes > 24 * 1024 * 1024);
  });

  it('десятиминутное видео принимается, одиннадцатиминутное — нет', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg недоступен');
    // Длительность берётся из метаданных, поэтому реальные 10 минут кодировать
    // не нужно: достаточно файла с такой длительностью.
    const ten = join(dir, 'ten_min.mp4');
    await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=320x568:rate=2:duration=600',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', ten]);

    const prod = { ...LIMITS, maxSingleVideoSeconds: 600 };
    const info = await inspectAsset({
      localPath: ten, declaredType: 'video', limits: prod, ffprobePath: 'ffprobe',
    });
    assert.ok(info.durationSeconds >= 599 && info.durationSeconds <= 601,
      `длительность ${info.durationSeconds}`);

    await assert.rejects(
      inspectAsset({
        localPath: ten, declaredType: 'video',
        limits: { ...prod, maxSingleVideoSeconds: 599 },
        ffprobePath: 'ffprobe',
      }),
      (e) => e instanceof ApiError && e.code === 'MEDIA_TOO_LONG',
    );
  });
});

describe('изображения', () => {
  it('JPG и JPEG распознаются одинаково', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg недоступен');
    for (const name of ['photo.jpg', 'photo.jpeg']) {
      const path = join(dir, name);
      await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc=size=1080x1920:rate=1:duration=1',
        '-frames:v', '1', '-q:v', '2', path]);

      const info = await inspectAsset({
        localPath: path, declaredType: 'photo', limits: LIMITS, ffprobePath: 'ffprobe',
      });
      assert.equal(info.type, 'photo', name);
      assert.equal(info.videoCodec, 'mjpeg', name);
      assert.equal(info.width, 1080, name);
      assert.equal(info.height, 1920, name);
      assert.equal(info.durationSeconds, null, name);
    }
  });

  it('PNG проходит', async (t) => {
    if (!hasFfmpeg) return t.skip('ffmpeg недоступен');
    const path = join(dir, 'pic.png');
    await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=640x1136:rate=1:duration=1',
      '-frames:v', '1', path]);
    const info = await inspectAsset({
      localPath: path, declaredType: 'photo', limits: LIMITS, ffprobePath: 'ffprobe',
    });
    assert.equal(info.type, 'photo');
    assert.equal(info.videoCodec, 'png');
  });
});
