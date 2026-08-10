// Cloud media adapter на НАСТОЯЩЕМ ffmpeg (§ фикс media=undefined): fake GCS
// отдаёт РЕАЛЬНЫЕ байты MP4, адаптер скачивает их и прогоняет НАСТОЯЩИЙ
// local-analysis pipeline (ffprobe/сцены/кадры/аудио). Это прямая проверка того,
// что раньше падало на probing.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, test } from 'node:test';

import { createGcsMedia } from '../../src/media.js';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${bin} exit ${code}: ${stderr.slice(-300)}`)),
    );
  });
}

async function available() {
  try {
    await run(FFMPEG, ['-hide_banner', '-version']);
    await run(FFPROBE, ['-hide_banner', '-version']);
    return true;
  } catch {
    return false;
  }
}

async function makeVideoWithAudio(filePath) {
  await run(FFMPEG, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x568:rate=15:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', '-y', filePath,
  ]);
  return filePath;
}

/** Fake GCS, отдающий реальные байты одного объекта. */
function storageServing(objectPath, bytes, generation = '7') {
  return {
    bucket() {
      return {
        file(p, opts = {}) {
          return {
            async getMetadata() {
              if (p !== objectPath) {
                const e = new Error('nf');
                e.code = 404;
                throw e;
              }
              return [{ size: String(bytes.length), contentType: 'video/mp4', generation }];
            },
            createReadStream() {
              const r = new Readable({ read() {} });
              queueMicrotask(() => {
                if (p !== objectPath || (opts.generation && String(opts.generation) !== generation)) {
                  const e = new Error('nf');
                  e.code = 404;
                  r.destroy(e);
                  return;
                }
                r.push(bytes);
                r.push(null);
              });
              return r;
            },
          };
        },
      };
    },
  };
}

const ready = await available();

describe('cloud media adapter e2e', { skip: ready ? false : 'ffmpeg недоступен' }, () => {
  test('скачивает реальный MP4 из GCS и прогоняет настоящий ffprobe/frames/audio', { timeout: 120_000 }, async () => {
    const uid = 'user_e2e';
    const projectId = 'proj_e2e';
    const objectPath = `users/${uid}/projects/${projectId}/sources/asset_a.mp4`;

    const srcDir = await mkdtemp(path.join(os.tmpdir(), 'reelio-src-'));
    const srcFile = await makeVideoWithAudio(path.join(srcDir, 'in.mp4'));
    const bytes = await readFile(srcFile);
    const wantHash = createHash('sha256').update(bytes).digest('hex');

    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'reelio-adapter-'));
    const media = createGcsMedia({
      storage: storageServing(objectPath, bytes),
      bucket: 'reelio-v2-beta-gemini-503615',
      ffmpegPath: FFMPEG,
      ffprobePath: FFPROBE,
      tmpDir,
      // analysis НЕ подменяем — работает НАСТОЯЩИЙ local-analysis pipeline.
    });

    const asset = { id: 'asset_a', type: 'video', objectPath };
    const ctx = { uid, projectId };

    const measured = await media.measure(asset, ctx);
    assert.equal(measured.contentHash, wantHash, 'contentHash = sha256 скачанных байтов');
    assert.ok(Math.abs(measured.durationSeconds - 4) < 0.6, `duration ~4s, got ${measured.durationSeconds}`);
    assert.equal(measured.width, 320);
    assert.equal(measured.height, 568);
    assert.equal(measured.hasAudio, true);
    assert.ok(measured.scenes.length >= 1);

    const sample = await media.sample(asset, measured, ctx);
    assert.ok(sample.frames.length >= 1, 'реальные кадры извлечены');
    // Кадр — настоящий JPEG (base64 начинается с /9j/).
    assert.ok(sample.frames[0].data.startsWith('/9j/'), 'кадр — JPEG');
    assert.equal(sample.frames[0].mimeType, 'image/jpeg');
    assert.ok(sample.audio, 'аудио извлечено');
    assert.ok(sample.audioSeconds > 0);

    assert.equal(readdirSync(tmpDir).filter((n) => n.startsWith('reelio-an-')).length, 1, 'до release каталог есть');
    await media.release(measured);
    assert.equal(
      existsSync(tmpDir) ? readdirSync(tmpDir).filter((n) => n.startsWith('reelio-an-')).length : 0,
      0,
      'после release каталог удалён',
    );
  });
});
