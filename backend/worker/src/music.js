// Музыкальная подложка: `music.track` (§2) → источник звука для FFmpeg.
//
// Контракт задаёт трек перечислением (chill | energy | cinematic | trending),
// но не описывает, откуда берутся сами файлы: это ресурс образа, а не поле
// плана. Поэтому здесь два уровня:
//
//   1. Файл ${REELIO_MUSIC_DIR}/{track}.{m4a|mp3|wav|ogg} — то, что используется
//      в проде: настоящие лицензированные треки монтируются в образ или в том.
//   2. Синтезированная подложка через lavfi — детерминированный запасной
//      вариант, если файла нет. Он нужен не «чтобы было красиво», а чтобы
//      music-тракт и ducking (§2) оставались рабочими и проверяемыми без
//      бинарных ассетов в репозитории.

import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

const EXTENSIONS = ['m4a', 'mp3', 'wav', 'ogg', 'opus', 'flac'];

/**
 * Параметры синтеза по трекам. Каждая подложка — сумма трёх синусов (аккорд)
 * с медленной огибающей; `pulse` добавляет ритмическую пульсацию.
 */
export const SYNTH_TRACKS = {
  chill: { chord: [220.0, 277.18, 329.63], lfo: 0.08, pulse: 0, gain: 0.22 },
  energy: { chord: [220.0, 329.63, 440.0], lfo: 0.25, pulse: 2.0, gain: 0.26 },
  cinematic: { chord: [110.0, 164.81, 220.0], lfo: 0.04, pulse: 0, gain: 0.24 },
  trending: { chord: [196.0, 246.94, 293.66], lfo: 0.2, pulse: 1.9, gain: 0.25 },
};

/**
 * Выражение aevalsrc для одного канала.
 *
 * Важное ограничение: запятая в выражении — разделитель фильтров для парсера
 * FFmpeg, поэтому `min()`/`max()` здесь использовать нельзя. Плавные вход и
 * выход даёт экспоненциальная огибающая: она сама зажата в 0..1 и не щёлкает
 * на краях.
 */
export function synthExpression(spec, duration, detune = 0) {
  const [a, b, c] = spec.chord.map((f) => (f * (1 + detune)).toFixed(4));
  const envelope = `(0.65+0.35*sin(2*PI*${spec.lfo}*t))`;
  const pulse = spec.pulse > 0 ? `*(0.55+0.45*abs(sin(PI*${spec.pulse}*t)))` : '';
  const fadeIn = `(1-exp(-t/0.6))`;
  const fadeOut = `(1-exp(-(${duration.toFixed(3)}-t)/0.6))`;
  const tone = `(0.5*sin(2*PI*${a}*t)+0.32*sin(2*PI*${b}*t)+0.22*sin(2*PI*${c}*t))`;
  return `${spec.gain}*${tone}*${envelope}${pulse}*${fadeIn}*${fadeOut}`;
}

/**
 * Ищет файл трека в каталоге образа.
 * @returns {Promise<string|null>} путь либо null
 */
export async function findTrackFile(musicDir, track) {
  if (!musicDir || track === 'none') return null;
  for (const ext of EXTENSIONS) {
    const candidate = path.join(musicDir, `${track}.${ext}`);
    try {
      await access(candidate, constants.R_OK);
      return candidate;
    } catch {
      // Следующее расширение.
    }
  }
  return null;
}

/**
 * Готовый источник музыки для командной строки FFmpeg.
 *
 * @param {{track: string, musicDir: string, duration: number}} opts
 * @returns {Promise<null | {kind: 'file'|'synth', inputArgs: string[], label: string}>}
 */
export async function resolveMusicInput({ track, musicDir, duration }) {
  if (!track || track === 'none') return null;

  const file = await findTrackFile(musicDir, track);
  if (file) {
    // Трек короче ролика зацикливаем, длиннее — обрежем в фильтре.
    return { kind: 'file', inputArgs: ['-stream_loop', '-1', '-i', file], label: track };
  }

  const spec = SYNTH_TRACKS[track] ?? SYNTH_TRACKS.chill;
  // Лёгкая расстройка второго канала даёт стереоширину.
  const left = synthExpression(spec, duration, 0);
  const right = synthExpression(spec, duration, 0.002);
  const source = `aevalsrc=exprs=${left}|${right}:sample_rate=48000:duration=${duration.toFixed(3)}`;

  return { kind: 'synth', inputArgs: ['-f', 'lavfi', '-i', source], label: `${track} (synth)` };
}
