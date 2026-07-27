// Запуск ffmpeg/ffprobe: разбор прогресса, кооперативная отмена, определение
// возможностей сборки.
//
// Сборки FFmpeg различаются набором фильтров (libass, libfreetype есть не
// везде), поэтому пайплайн спрашивает возможности у бинаря, а не полагается на
// удачу. Отсутствие libass деградирует субтитры до sidecar-файла, а не роняет
// рендер.

import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';

import { WorkerError } from './errors.js';

/** Хвост stderr, который сохраняем для worker.log (наружу не уходит). */
const STDERR_TAIL_BYTES = 8000;

function tail(text, limit = STDERR_TAIL_BYTES) {
  return text.length > limit ? text.slice(-limit) : text;
}

/**
 * Разбирает поток `-progress pipe:1`: строки вида `key=value`, блок
 * заканчивается `progress=continue|end`.
 */
export function createProgressParser(onSample) {
  let pending = '';
  let current = {};

  return function push(chunk) {
    pending += chunk;
    let nl = pending.indexOf('\n');
    while (nl >= 0) {
      const line = pending.slice(0, nl).trim();
      pending = pending.slice(nl + 1);
      nl = pending.indexOf('\n');

      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq);
      const value = line.slice(eq + 1);
      current[key] = value;

      if (key === 'progress') {
        const micros = Number(current.out_time_us ?? current.out_time_ms ?? NaN);
        const seconds = Number.isFinite(micros) ? micros / 1_000_000 : null;
        onSample({
          seconds,
          frame: Number(current.frame) || 0,
          speed: current.speed ?? '',
          done: value === 'end',
        });
        current = {};
      }
    }
  };
}

/**
 * Запускает ffmpeg. Отмена (§8.1) — через AbortSignal: сначала SIGTERM, чтобы
 * FFmpeg успел закрыть файлы, затем SIGKILL по таймауту.
 *
 * @param {string} bin путь к ffmpeg
 * @param {string[]} args аргументы
 * @param {{onProgress?: (s: {seconds: number|null}) => void, signal?: AbortSignal,
 *          logger?: any, killGraceMs?: number}} [opts]
 */
export function runFfmpeg(bin, args, opts = {}) {
  const { onProgress, signal, logger, killGraceMs = 5000 } = opts;

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let aborted = false;
    /** @type {NodeJS.Timeout | null} */
    let killTimer = null;

    const parse = onProgress ? createProgressParser(onProgress) : null;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => parse?.(chunk));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = tail(stderr + chunk);
    });

    const onAbort = () => {
      aborted = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
      killTimer.unref?.();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      if (killTimer) clearTimeout(killTimer);
      reject(
        new WorkerError('WORKER_FAILED', 'Не удалось запустить обработку видео.', {
          detail: `spawn failed: ${err.code || err.message}`,
          cause: err,
        }),
      );
    });

    child.on('close', (code, sig) => {
      signal?.removeEventListener('abort', onAbort);
      if (killTimer) clearTimeout(killTimer);

      if (aborted) {
        resolve({ code: code ?? -1, aborted: true, stderr });
        return;
      }
      if (code === 0) {
        resolve({ code: 0, aborted: false, stderr });
        return;
      }
      logger?.error('ffmpeg exited non-zero', { code, signal: sig, stderr: tail(stderr, 2000) });
      reject(
        new WorkerError('WORKER_FAILED', 'Не удалось собрать видео.', {
          detail: `ffmpeg exit ${code}${sig ? ` (${sig})` : ''}: ${tail(stderr, 2000)}`,
        }),
      );
    });
  });
}

/** ffprobe → разобранный JSON. Ошибка означает «материал не читается» (§7). */
export async function runFfprobe(bin, filePath, extraArgs = []) {
  const args = [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    ...extraArgs,
    filePath,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => {
      stderr = tail(stderr + c, 2000);
    });

    child.on('error', (err) =>
      reject(
        new WorkerError('WORKER_FAILED', 'Не удалось проанализировать материал.', {
          detail: `ffprobe spawn failed: ${err.code || err.message}`,
        }),
      ),
    );

    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          new WorkerError('SOURCE_UNREADABLE', 'Исходный материал повреждён или не поддерживается.', {
            detail: `ffprobe exit ${code}: ${stderr}`,
          }),
        );
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(
          new WorkerError('SOURCE_UNREADABLE', 'Исходный материал повреждён или не поддерживается.', {
            detail: 'ffprobe returned malformed JSON',
          }),
        );
      }
    });
  });
}

/** Одноразовый запуск ffmpeg ради текста в stdout/stderr (списки фильтров). */
function capture(bin, args) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => {
      out += c;
    });
    child.stderr.on('data', (c) => {
      out += c;
    });
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(out));
  });
}

/**
 * Разбирает `ffmpeg -h filter=xfade` в множество доступных режимов перехода.
 * Строки вида «   fade            0            ..FV.......».
 */
export function parseXfadeTransitions(help) {
  const transitions = new Set();
  const section = help.split(/transition\s+<int>/)[1];
  if (!section) return transitions;

  for (const line of section.split('\n')) {
    const match = /^\s{5,}([a-z][a-z0-9]*)\s+\d+\s/.exec(line);
    if (match) transitions.add(match[1]);
    // Список опций закончился — начался следующий параметр фильтра.
    else if (/^\s{0,4}\S/.test(line) && transitions.size > 0) break;
  }
  return transitions;
}

/**
 * Какие фильтры и кодеки реально есть в этой сборке FFmpeg.
 * `subtitles` требует libass, `drawtext` — libfreetype; в минимальных сборках
 * (например, homebrew по умолчанию) их нет.
 */
export async function detectCapabilities(ffmpegPath) {
  const [filters, encoders, version, xfadeHelp] = await Promise.all([
    capture(ffmpegPath, ['-hide_banner', '-filters']),
    capture(ffmpegPath, ['-hide_banner', '-encoders']),
    capture(ffmpegPath, ['-hide_banner', '-version']),
    capture(ffmpegPath, ['-hide_banner', '-h', 'filter=xfade']),
  ]);

  const hasFilter = (name) => new RegExp(`^\\s*\\S+\\s+${name}\\s`, 'm').test(filters);
  const hasEncoder = (name) => new RegExp(`^\\s*\\S+\\s+${name}\\s`, 'm').test(encoders);

  return {
    version: version.split('\n')[0]?.trim() ?? '',
    // Набор переходов рос от версии к версии (zoomin появился позже slideleft),
    // поэтому список берётся у самого бинаря, а не предполагается.
    xfadeTransitions: parseXfadeTransitions(xfadeHelp),
    subtitles: hasFilter('subtitles'),
    drawtext: hasFilter('drawtext'),
    xfade: hasFilter('xfade'),
    acrossfade: hasFilter('acrossfade'),
    zoompan: hasFilter('zoompan'),
    loudnorm: hasFilter('loudnorm'),
    alimiter: hasFilter('alimiter'),
    libx264: hasEncoder('libx264'),
    aac: hasEncoder('aac'),
  };
}

/** Обязательный минимум: без него собрать MP4 по §1 невозможно. */
export function assertCapabilities(caps) {
  const missing = [];
  if (!caps.libx264) missing.push('libx264');
  if (!caps.aac) missing.push('aac');
  if (!caps.xfade) missing.push('xfade');
  if (missing.length) {
    throw new WorkerError('WORKER_FAILED', 'Обработчик видео собран без нужных кодеков.', {
      detail: `ffmpeg build is missing: ${missing.join(', ')}`,
    });
  }
}

/**
 * Проверяет +faststart: в MP4 с faststart блок `moov` идёт ДО `mdat`.
 * Читаем только заголовки боксов, а не весь файл.
 */
export async function hasFastStart(filePath) {
  const handle = await open(filePath, 'r');
  try {
    let offset = 0;
    const header = Buffer.alloc(16);

    for (let i = 0; i < 64; i += 1) {
      const { bytesRead } = await handle.read(header, 0, 16, offset);
      if (bytesRead < 8) return false;

      let size = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);
      let headerSize = 8;

      if (size === 1) {
        // 64-битный размер лежит сразу за типом бокса.
        if (bytesRead < 16) return false;
        size = Number(header.readBigUInt64BE(8));
        headerSize = 16;
      } else if (size === 0) {
        // Бокс до конца файла — дальше ничего нет.
        return type === 'moov';
      }

      if (type === 'moov') return true;
      if (type === 'mdat') return false;
      if (size < headerSize) return false;
      offset += size;
    }
    return false;
  } finally {
    await handle.close();
  }
}
