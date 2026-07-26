// Внутренний канал worker → backend (§8.1 контракта).
//
// Worker не имеет доступа к Firestore: весь прогресс идёт через
// POST /internal/jobs/{id}/progress с Bearer-токеном. Здесь же живут два
// обязательства контракта:
//   • heartbeat не реже чем раз в 30 с (§4.2);
//   • проверка cancelRequested в КАЖДОМ ответе — это и есть кооперативная
//     отмена из POST /jobs/{id}/cancel.

import { PHASES, progressFor } from './contract.js';
import { CancelledError, WorkerError } from './errors.js';

/** Ответ backend'а, когда канал не сконфигурирован (local mode без URL). */
const OFFLINE_REPLY = { ok: true, cancelRequested: false, status: 'running' };

export class ProgressReporter {
  /**
   * @param {{url: string, token: string, jobId: string, logger: any,
   *          heartbeatMs?: number, fetchImpl?: typeof fetch, timeoutMs?: number}} opts
   */
  constructor(opts) {
    this.url = opts.url || '';
    this.token = opts.token || '';
    this.jobId = opts.jobId;
    this.logger = opts.logger;
    this.heartbeatMs = opts.heartbeatMs ?? 15_000;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;

    this.enabled = Boolean(this.url);
    this.cancelRequested = false;
    /** Задача уже терминальна на стороне backend'а — работать дальше нельзя. */
    this.terminated = false;

    this.phase = 'preparing';
    this.fraction = 0;
    this.message = '';
    /** @type {NodeJS.Timeout | null} */
    this.timer = null;
    /** Последняя отправленная точка — прогресс не должен убывать (§4). */
    this.lastGlobal = 0;
  }

  /** Запускает heartbeat-таймер. Он не держит процесс живым (unref). */
  start() {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => {
      // Ошибки heartbeat не должны валить рендер — их обрабатывает send().
      this.#send({ phase: this.phase, fraction: this.fraction, message: this.message }, true).catch(
        () => {},
      );
    }, this.heartbeatMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Отчёт об этапе. `fraction` — прогресс ВНУТРИ этапа (0..1); в глобальный
   * диапазон его отображает backend (§8.1).
   *
   * §4 требует, чтобы `progress` не убывал. Внутри одного этапа доля может
   * дрогнуть (FFmpeg иногда отдаёт `out_time` назад на стыке фильтров), поэтому
   * долю здесь поднимают до уровня, на котором глобальный прогресс остаётся
   * прежним, — полоса в UI замирает, но не откатывается.
   */
  async report(phase, fraction = 0, message = '') {
    const spec = PHASES[phase];
    if (!spec) {
      throw new WorkerError('INTERNAL', 'Внутренняя ошибка рендера.', {
        detail: `unknown phase ${phase}`,
      });
    }

    let safeFraction = Math.min(1, Math.max(0, Number(fraction) || 0));

    // Терминальные фазы прогресс замораживают (§4.2), их не выравниваем.
    if (spec.status === 'running' || spec.status === 'queued') {
      if (progressFor(phase, safeFraction) < this.lastGlobal && spec.to > this.lastGlobal) {
        const span = spec.to - spec.from;
        // Округляем: обратный пересчёт из глобального прогресса иначе даёт
        // «хвост» вроде 0.7999999999999998 прямо в теле запроса.
        safeFraction =
          span > 0
            ? Math.min(1, Number(((this.lastGlobal - spec.from) / span).toFixed(4)))
            : safeFraction;
      }
      this.lastGlobal = Math.max(this.lastGlobal, progressFor(phase, safeFraction));
    }

    this.phase = phase;
    this.fraction = safeFraction;
    this.message = message;
    return this.#send({ phase, fraction: safeFraction, message });
  }

  /** Финальный отчёт об успехе: phase done + RenderResult (§4.3). */
  async reportDone(result, message = 'Готово') {
    this.stop();
    return this.#send({ phase: 'done', fraction: 1, message, result });
  }

  /** Финальный отчёт об ошибке: phase failed + ErrorObject (§7). */
  async reportFailed(error, message = 'Рендер не удался') {
    this.stop();
    return this.#send({ phase: 'failed', fraction: 0, message, error });
  }

  /** Финальный отчёт об отмене (§8.1). */
  async reportCancelled(message = 'Рендер отменён') {
    this.stop();
    return this.#send({ phase: 'cancelled', fraction: 0, message });
  }

  /** Бросает CancelledError, если backend попросил остановиться. */
  throwIfCancelled() {
    if (this.cancelRequested) throw new CancelledError();
    if (this.terminated) {
      throw new CancelledError('Задача уже завершена, рендер остановлен.');
    }
  }

  async #send(body, isHeartbeat = false) {
    if (!this.enabled) return OFFLINE_REPLY;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (response.status === 404) {
        // §8.1: задача удалена — работать дальше бессмысленно.
        this.terminated = true;
        throw new CancelledError('Задача рендера не найдена, работа прекращена.');
      }
      if (response.status === 409) {
        // §8.1: задача уже терминальна — worker обязан немедленно прекратить.
        this.terminated = true;
        throw new CancelledError('Задача уже завершена, рендер остановлен.');
      }
      if (!response.ok) {
        // Не терминальная ошибка канала: логируем и продолжаем рендер.
        this.logger?.warn('progress channel returned non-2xx', { status: response.status });
        return OFFLINE_REPLY;
      }

      const reply = await response.json().catch(() => OFFLINE_REPLY);
      if (reply?.cancelRequested === true) {
        this.cancelRequested = true;
      }
      return reply ?? OFFLINE_REPLY;
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      // Сеть моргнула — рендер продолжается; backend поймает нас по heartbeat
      // timeout (§4.2), если связь не восстановится.
      this.logger?.warn('progress channel unreachable', {
        heartbeat: isHeartbeat,
        reason: err?.name || 'Error',
      });
      return OFFLINE_REPLY;
    } finally {
      clearTimeout(timer);
    }
  }
}
