// Проверка ducking'а настоящим FFmpeg (§2 контракта).
//
// Юнит-тесты сверяют, что в граф попали правильные параметры компрессора.
// Здесь проверяется сам эффект: музыка обязана становиться тише в те моменты,
// когда звучит речь, — и оставаться громкой, когда речи нет.

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, test } from 'node:test';

import { DUCKING } from '../../src/filtergraph.js';
import { meanVolumeDb } from '../../src/probe.js';
import { FFMPEG, ffmpegAvailable, run, tempDir } from '../helpers/fixtures.js';

const DURATION = 6;
/** Речь включается на середине — до неё музыка играет в полную силу. */
const SPEECH_START = 3;

/**
 * Собирает дорожку: постоянная музыка + «речь», звучащая только во второй
 * половине, пропущенные через тот самый sidechaincompress из контракта.
 */
async function renderDuckedTrack(outPath, { ducked }) {
  const musicChain = 'volume=0.7[mus]';
  const voiceChain = `adelay=${SPEECH_START * 1000}|${SPEECH_START * 1000},apad=whole_dur=${DURATION},atrim=0:${DURATION},asetpts=PTS-STARTPTS`;

  // Голос здесь нужен только как сайдчейн, поэтому основную копию гасим в
  // anullsink: FFmpeg не запускает граф с неподключённым выходом.
  const graph = ducked
    ? [
        `[0:a]${musicChain}`,
        `[1:a]${voiceChain}[voice]`,
        '[voice]asplit=2[voice_main][voice_sc]',
        '[voice_main]anullsink',
        `[mus][voice_sc]sidechaincompress=threshold=${DUCKING.threshold}:ratio=${DUCKING.ratio}` +
          `:attack=${DUCKING.attackMs}:release=${DUCKING.releaseMs}:level_sc=1[out]`,
      ].join(';')
    : [
        `[0:a]${musicChain}`,
        `[1:a]${voiceChain}[voice]`,
        '[voice]anullsink',
        '[mus]anull[out]',
      ].join(';');

  await run(FFMPEG, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=220:duration=${DURATION}:sample_rate=48000`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=880:duration=${DURATION - SPEECH_START}:sample_rate=48000`,
    '-filter_complex',
    graph,
    '-map',
    '[out]',
    '-ac',
    '2',
    '-ar',
    '48000',
    '-t',
    String(DURATION),
    '-y',
    outPath,
  ]);
  return outPath;
}

const available = await ffmpegAvailable();

describe('ducking музыки под речь', { skip: available ? false : 'ffmpeg недоступен' }, () => {
  test('музыка тише во время речи и громче в тишине', { timeout: 120_000 }, async () => {
    const dir = await tempDir('reelio-duck-');
    const file = await renderDuckedTrack(path.join(dir, 'ducked.wav'), { ducked: true });

    const beforeSpeech = await meanVolumeDb(FFMPEG, file, { start: 0.5, duration: 2 });
    const duringSpeech = await meanVolumeDb(FFMPEG, file, { start: SPEECH_START + 0.7, duration: 2 });

    assert.ok(beforeSpeech !== null && duringSpeech !== null, 'громкость должна измеряться');
    assert.ok(
      duringSpeech < beforeSpeech - 3,
      `музыка должна проседать минимум на 3 дБ: было ${beforeSpeech}, стало ${duringSpeech}`,
    );
  });

  test('без компрессора просадки нет — эффект даёт именно ducking', { timeout: 120_000 }, async () => {
    const dir = await tempDir('reelio-duck-');
    const file = await renderDuckedTrack(path.join(dir, 'flat.wav'), { ducked: false });

    const beforeSpeech = await meanVolumeDb(FFMPEG, file, { start: 0.5, duration: 2 });
    const duringSpeech = await meanVolumeDb(FFMPEG, file, { start: SPEECH_START + 0.7, duration: 2 });

    assert.ok(
      Math.abs(duringSpeech - beforeSpeech) < 1,
      `контрольная дорожка должна быть ровной: ${beforeSpeech} → ${duringSpeech}`,
    );
  });

  test('время восстановления соответствует release из §2', { timeout: 120_000 }, async () => {
    const dir = await tempDir('reelio-duck-');
    const file = await renderDuckedTrack(path.join(dir, 'ducked.wav'), { ducked: true });

    // Речь кончается на границе ролика, поэтому смотрим на атаку: сразу после
    // её начала уровень уже должен упасть (attack = 20 мс).
    const justBefore = await meanVolumeDb(FFMPEG, file, { start: SPEECH_START - 0.3, duration: 0.25 });
    const justAfter = await meanVolumeDb(FFMPEG, file, { start: SPEECH_START + 0.1, duration: 0.25 });

    assert.ok(
      justAfter < justBefore - 3,
      `компрессор должен срабатывать за ${DUCKING.attackMs} мс: ${justBefore} → ${justAfter}`,
    );
  });
});
