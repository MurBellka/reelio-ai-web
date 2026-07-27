// Каждый переход каталога §2.1 — на настоящем FFmpeg и синтетических клипах.
//
// Юнит-тесты проверяют, что в граф попал нужный режим xfade. Здесь проверяется
// то, что нельзя проверить строкой: переход действительно рендерится, ролик
// получается валидным и его длительность совпадает с расчётом таймлайна
// (то есть перекрытие сработало ровно так, как обещано).
//
// Заодно здесь же генерируются короткие превью §2.4 — те самые, которые UI
// показывает пользователю при выборе перехода.

import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';

import { detectCapabilities, hasFastStart, runFfmpeg } from '../../src/ffmpeg.js';
import { buildRenderCommand } from '../../src/filtergraph.js';
import { verifyOutput } from '../../src/probe.js';
import { buildTimeline } from '../../src/timeline.js';
import { TRANSITION_CATALOG, buildVerifiedCatalog } from '../../src/transitions.js';
import { FFMPEG, FFPROBE, ffmpegAvailable, makeVideo, tempDir } from '../helpers/fixtures.js';

/** Кадр превью — маленький, чтобы прогон по всему каталогу был быстрым. */
const FRAME = { width: 270, height: 480 };
const FPS = 30;
const CLIP_SECONDS = 1;
const TRANSITION_SECONDS = 0.4;

/** План из двух синтетических клипов с заданным переходом. */
function makeSpec(type, sources) {
  const clips = [
    {
      id: 'c1',
      mediaId: 'a',
      type: 'video',
      duration: CLIP_SECONDS,
      start: 0,
      end: CLIP_SECONDS,
      transition: { type: 'cut', durationSeconds: null, intensity: 'balanced' },
    },
    {
      id: 'c2',
      mediaId: 'b',
      type: 'video',
      duration: CLIP_SECONDS,
      start: 0,
      end: CLIP_SECONDS,
      transition: { type, durationSeconds: TRANSITION_SECONDS, intensity: 'balanced' },
    },
  ];

  return {
    plan: {
      audio: { keepOriginal: true },
      music: undefined,
      export: {
        resolution: 'hd720',
        width: FRAME.width,
        height: FRAME.height,
        fps: FPS,
        videoBitrateKbps: 2000,
        maxrateKbps: 2500,
        audioBitrateKbps: 128,
        level: '4.0',
        preset: null,
      },
      clips,
    },
    timeline: buildTimeline(clips),
    sources,
  };
}

const available = await ffmpegAvailable();

describe('переходы на синтетических клипах', { skip: available ? false : 'ffmpeg недоступен' }, () => {
  test('каждый переход каталога рендерится в валидный MP4', { timeout: 900_000 }, async () => {
    const dir = await tempDir('reelio-trans-');
    const previewDir = path.join(dir, 'previews');
    await mkdir(previewDir, { recursive: true });

    // Два заметно разных клипа: на однотонных кадрах переход не отличить.
    const a = await makeVideo(path.join(dir, 'a.mp4'), {
      duration: CLIP_SECONDS,
      width: 320,
      height: 240,
      fps: FPS,
    });
    const b = await makeVideo(path.join(dir, 'b.mp4'), {
      duration: CLIP_SECONDS,
      width: 240,
      height: 320,
      fps: FPS,
      silent: true,
    });

    const sources = new Map([
      ['a', { filePath: a, hasAudio: true, width: 320, height: 240 }],
      ['b', { filePath: b, hasAudio: true, width: 240, height: 320 }],
    ]);

    const capabilities = await detectCapabilities(FFMPEG);
    const verified = buildVerifiedCatalog(capabilities.xfadeTransitions);
    assert.ok(verified.types.length > 1, 'каталог не должен быть пустым');

    const checked = [];
    const skipped = [];

    for (const type of Object.keys(TRANSITION_CATALOG)) {
      // Синонимы дают тот же фильтр — отдельно рендерить их незачем.
      if (TRANSITION_CATALOG[type].aliasOf) continue;

      if (!verified.byType[type]) {
        skipped.push(type);
        continue;
      }

      const spec = makeSpec(type, sources);
      const outputPath = path.join(previewDir, `${type}.mp4`);

      const command = buildRenderCommand({
        ...spec,
        fitMode: 'cover',
        capabilities,
        verifiedCatalog: verified,
        subtitlePath: null,
        overlayPath: null,
        fontsDir: null,
        outputPath,
        preset: 'ultrafast',
      });

      await runFfmpeg(FFMPEG, command.args);

      const verification = await verifyOutput(FFPROBE, outputPath, {
        ...FRAME,
        fps: FPS,
        durationSeconds: command.expectedDuration,
        hasAudio: true,
      });
      assert.deepEqual(verification.problems, [], `переход ${type}`);
      assert.equal(await hasFastStart(outputPath), true, `переход ${type}: faststart`);

      // Перекрытие обязано укоротить ролик ровно на длительность перехода.
      const expected =
        type === 'cut' ? 2 * CLIP_SECONDS : 2 * CLIP_SECONDS - TRANSITION_SECONDS;
      assert.ok(
        Math.abs(command.expectedDuration - expected) < 0.001,
        `переход ${type}: ожидалось ${expected} с, таймлайн дал ${command.expectedDuration}`,
      );
      assert.ok(
        Math.abs(verification.info.durationSeconds - expected) < 0.25,
        `переход ${type}: в MP4 ${verification.info.durationSeconds} с вместо ${expected}`,
      );

      checked.push(type);
    }

    assert.ok(
      checked.length >= 20,
      `проверено всего ${checked.length} переходов, пропущено: ${skipped.join(', ')}`,
    );
    assert.ok(checked.includes('cut'));
    assert.ok(checked.includes('dissolve'));
    assert.ok(checked.includes('zoomIn'));
    assert.ok(checked.includes('blur'));
  });

  test('превью §2.4 короткие и пригодны для показа в UI', { timeout: 300_000 }, async () => {
    const dir = await tempDir('reelio-preview-');
    const a = await makeVideo(path.join(dir, 'a.mp4'), { duration: 1, width: 320, height: 240, fps: FPS });
    const b = await makeVideo(path.join(dir, 'b.mp4'), { duration: 1, width: 320, height: 240, fps: FPS });

    const sources = new Map([
      ['a', { filePath: a, hasAudio: true }],
      ['b', { filePath: b, hasAudio: true }],
    ]);

    const capabilities = await detectCapabilities(FFMPEG);
    const spec = makeSpec('circleOpen', sources);
    const outputPath = path.join(dir, 'preview.mp4');

    const command = buildRenderCommand({
      ...spec,
      fitMode: 'cover',
      capabilities,
      verifiedCatalog: buildVerifiedCatalog(capabilities.xfadeTransitions),
      subtitlePath: null,
      overlayPath: null,
      fontsDir: null,
      outputPath,
      preset: 'ultrafast',
    });
    await runFfmpeg(FFMPEG, command.args);

    const verification = await verifyOutput(FFPROBE, outputPath, {
      ...FRAME,
      fps: FPS,
      durationSeconds: command.expectedDuration,
      hasAudio: true,
    });
    assert.deepEqual(verification.problems, []);
    // Превью должно быть коротким: его листают в списке.
    assert.ok(verification.info.durationSeconds < 2.5);
    assert.ok(verification.info.sizeBytes < 2_000_000, 'превью не должно весить мегабайты');
  });
});
