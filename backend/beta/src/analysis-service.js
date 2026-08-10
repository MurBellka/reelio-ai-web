// Сервис анализа: жизненный цикл задачи (§4, §6, §12 задания итерации 2).
//
// Здесь сходятся все требования к повторам и лимитам:
//
// §4 — повтор одного запроса не вызывает Gemini заново и не списывает лимит.
//   Обеспечивается двумя уровнями. Первый: отпечаток ЗАПРОСА — повторный
//   POST с тем же ключом возвращает ту же задачу, новая не создаётся. Второй:
//   отпечаток СОДЕРЖИМОГО каждого материала — даже в новой задаче уже
//   проанализированный файл берётся из кэша.
//
// §5 — многократный анализ одного материала не обходит суточный лимит.
//   Квота списывается ровно тогда, когда мы действительно идём в Gemini.
//   Кэш-попадание бесплатно, но и нового результата не даёт; кэш-промах
//   платный. Ключ кэша считается от содержимого и включает uid, поэтому ни
//   переименованием, ни чужим идентификатором его не обмануть.

import { CostBudget, LimitExceededError, assertProjectWithinLimits } from './limits.js';
import { DEFAULT_QUEUE_TIMEOUT_MS } from './config.js';
import { ApiError, toApiError } from './errors.js';
import { GEMINI_ANALYSIS_SCHEMA, GEMINI_SPEECH_SCHEMA, validateMediaAnalysis } from './analysis-schema.js';
import { buildAnalysisPrompt, buildSpeechPrompt } from './prompts.js';
import { TERMINAL_STATUSES, analysisFingerprint, newId, requestFingerprint, sha256 } from './store.js';

/** Фазы анализа и их вклад в прогресс — по образцу §4.2 контракта рендера. */
export const ANALYSIS_PHASES = {
  queued: { status: 'queued', from: 0, to: 0.05 },
  probing: { status: 'running', from: 0.05, to: 0.2 },
  sampling: { status: 'running', from: 0.2, to: 0.4 },
  understanding: { status: 'running', from: 0.4, to: 0.8 },
  transcribing: { status: 'running', from: 0.8, to: 0.95 },
  planning: { status: 'running', from: 0.95, to: 1 },
  done: { status: 'succeeded', from: 1, to: 1 },
  failed: { status: 'failed', from: 0, to: 1 },
  cancelled: { status: 'cancelled', from: 0, to: 1 },
};

export function progressFor(phase, fraction = 0) {
  const spec = ANALYSIS_PHASES[phase];
  if (!spec) return 0;
  const f = Math.min(1, Math.max(0, Number(fraction) || 0));
  return Number((spec.from + (spec.to - spec.from) * f).toFixed(4));
}

/** Публичное представление задачи. Внутренних полей клиенту не отдаём. */
export function toPublicJob(job) {
  return {
    analysisId: job.id,
    projectId: job.projectId,
    status: job.status,
    phase: job.phase,
    progress: job.progress,
    message: job.message,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt ?? null,
    // Стоимость показывается в кредитах, а не в долларах: пользователю не
    // нужно знать наш прайс у поставщика модели.
    creditsSpent: job.creditsSpent ?? 0,
    fromCache: job.fromCache ?? false,
    assetsAnalyzed: job.assetsAnalyzed ?? 0,
    assetsTotal: job.assetsTotal ?? 0,
    error: job.error ?? null,
    warnings: job.warnings ?? [],
  };
}

export class AnalysisService {
  /**
   * @param {{store: object, quota: object, limits: object, gemini: object|null,
   *          media: object, logger?: object, now?: () => Date,
   *          taskQueue?: object, watchdogQueue?: object|null,
   *          queueTimeoutMs?: number}} deps
   */
  constructor(deps) {
    this.store = deps.store;
    this.quota = deps.quota;
    this.limits = deps.limits;
    this.gemini = deps.gemini;
    /** Абстракция доступа к материалам: скачивание и локальный анализ. */
    this.media = deps.media;
    this.logger = deps.logger ?? null;
    this.now = deps.now ?? (() => new Date());
    /** jobId → AbortController, для кооперативной отмены в этом инстансе. */
    this.running = new Map();

    // §4A.9: watchdog зависших `queued`. В облаке — отложенная Cloud Task на
    // reap-endpoint; локально/в тестах отсутствует (null), защиту даёт проверка
    // просроченных queued при обращении к задаче и резервировании слота.
    this.watchdogQueue = deps.watchdogQueue ?? null;
    /** Потолок ожидания в `queued`, после которого попытка признаётся потерянной. */
    this.queueTimeoutMs = deps.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS;

    // Долговечное выполнение (§4A.7): вместо fire-and-forget задача ставится в
    // очередь. В облаке это Cloud Tasks (переживает перезапуск инстанса); по
    // умолчанию — минимальная встроенная очередь, запускающая обработчик
    // асинхронно (для тестов и local mode). enqueue сам НЕ ждёт результата.
    this.taskQueue = deps.taskQueue ?? {
      enqueue: (payload) => {
        const p = Promise.resolve().then(() => this.runJob(payload.jobId, payload));
        this._pending = (this._pending ?? Promise.resolve()).then(() => p.catch(() => {}));
        return Promise.resolve({ scheduled: true });
      },
    };
  }

  /**
   * Создаёт задачу анализа либо возвращает существующую (§4).
   *
   * @param {{uid: string, projectId: string, assets: object[],
   *          idempotencyKey?: string}} request
   */
  async createAnalysis(request) {
    const { uid, projectId, assets, idempotencyKey } = request;

    if (!Array.isArray(assets) || assets.length === 0) {
      throw new ApiError('INVALID_REQUEST', 'Не переданы материалы для анализа.', { field: 'assets' });
    }

    // §10 — состав проекта проверяется до любой платной работы.
    try {
      assertProjectWithinLimits({
        videos: assets.filter((a) => a.type === 'video').length,
        photos: assets.filter((a) => a.type === 'photo').length,
        longestVideoSeconds: Math.max(0, ...assets.map((a) => Number(a.durationSeconds) || 0)),
      });
    } catch (err) {
      if (err instanceof LimitExceededError) {
        throw new ApiError('LIMIT_EXCEEDED', err.message, { field: err.limit });
      }
      throw err;
    }

    // Отпечаток запроса считается от СОДЕРЖИМОГО материалов, а не от их имён:
    // иначе повтор с переименованными ассетами создавал бы новую задачу.
    const contentHash = sha256(
      assets
        .map((a) => `${a.type}:${a.contentHash ?? a.objectPath}`)
        .sort()
        .join('|'),
    );
    const fingerprint = requestFingerprint({ uid, projectId, idempotencyKey, contentHash });

    // §4A.9: перед резервированием слота добиваем ПРОСРОЧЕННЫЕ `queued` попытки
    // этого пользователя — потерянная задача не должна вечно занимать слот и
    // блокировать новый анализ. Проверка идемпотентна и безопасна к гонкам.
    await this.#reapStaleForUser(uid);

    const created = await this.store.runTransaction(async (tx) => {
      const existing = await tx.findJobByFingerprint(fingerprint);
      if (existing) {
        // §4: тот же запрос — та же задача. Ни Gemini, ни квота не трогаются.
        // Повтор того же Idempotency-Key НЕ создаёт вторую попытку и не списывает
        // квоту повторно (§4A.9): enqueue ниже выполняется только для isNew.
        if (existing.uid !== uid) {
          throw new ApiError('FORBIDDEN', 'Анализ недоступен.');
        }
        return { job: existing, isNew: false };
      }

      if ((await tx.countActiveJobs(uid)) >= this.limits.maxActiveAnalyses) {
        throw new ApiError('TOO_MANY_ACTIVE_ANALYSES', 'Уже выполняется другой анализ.');
      }

      const now = this.now().toISOString();
      const job = await tx.putJob({
        id: newId('an'),
        uid,
        projectId,
        fingerprint,
        contentHash,
        status: 'queued',
        phase: 'queued',
        progress: 0,
        message: 'Ожидание очереди',
        createdAt: now,
        updatedAt: now,
        finishedAt: null,
        // §4A.9: номер попытки постановки в очередь (первая = 1) и момент
        // постановки — оба долговечны в Firestore; на них опирается watchdog.
        enqueueSeq: 1,
        queuedAt: now,
        assetsTotal: assets.length,
        assetsAnalyzed: 0,
        creditsSpent: 0,
        fromCache: false,
        warnings: [],
        error: null,
        analyses: [],
      });
      return { job, isNew: true };
    });

    if (created.isNew) {
      // §4A.7: не fire-and-forget, а долговечная очередь. HTTP-ответ уходит
      // сразу; обработчик запускается очередью и переживает перезапуск инстанса.
      const dispatched = await this.#dispatch({ job: created.job, uid, projectId, assets });
      return { job: dispatched.job, isNew: true };
    }

    return { job: created.job, isNew: created.isNew };
  }

  /**
   * Ставит задачу в очередь и планирует watchdog для КОНКРЕТНОЙ попытки
   * (enqueueSeq). Сбой enqueue → терминальный failed этой же попытки. Возвращает
   * актуальную задачу (failed при сбое). Общий путь для create и retry.
   */
  async #dispatch({ job, uid, projectId, assets }) {
    const enqueueSeq = job.enqueueSeq ?? 1;
    try {
      await this.taskQueue.enqueue({
        kind: 'analysis.run',
        jobId: job.id,
        uid,
        projectId,
        assets,
        enqueueSeq,
      });
    } catch (err) {
      // enqueue сорвался: задача НИКОГДА не выполнится. Нельзя оставлять её в
      // `queued` — иначе она навсегда занимает active slot и висит у клиента.
      const failed = await this.#failEnqueue(job.id, enqueueSeq, err);
      return { job: failed ?? job, isNew: true };
    }
    // §4A.9: страховка от потерянной/недоставленной задачи — отложенный reap.
    // Best-effort: сбой планирования watchdog'а не должен ломать анализ (его
    // подстрахует защитная проверка просроченных queued при обращении к задаче).
    await this.#scheduleWatchdog({ jobId: job.id, uid, projectId, enqueueSeq });
    return { job, isNew: true };
  }

  /**
   * Обработка сорвавшегося enqueue (§4A.7/§4A.9). Задача не будет выполнена,
   * поэтому переводим её в терминальное `failed` — это освобождает active slot
   * (countActiveJobs не считает терминальные) — и возвращаем списанную квоту
   * РОВНО ОДИН РАЗ (guard по терминальному статусу, как в cancelAnalysis).
   *
   * Критично для конкуренции (§4A.9): меняем задачу ТОЛЬКО если это всё ещё та
   * же попытка (`enqueueSeq` совпадает). Иначе параллельный retry уже поднял
   * НОВУЮ попытку, и старый callback ошибки enqueue не должен её обрушить.
   * Наружу — безопасный retryable-код: сбой очереди почти всегда транзиентный.
   * ALREADY_EXISTS сюда не попадает — очередь трактует его как идемпотентный успех.
   */
  async #failEnqueue(jobId, enqueueSeq, err) {
    const api = toApiError(err);
    this.logger?.warn?.('analysis enqueue failed', {
      jobId,
      enqueueSeq,
      code: api.code,
      detail: api.detail,
    });

    return this.store.runTransaction(async (tx) => {
      const current = await tx.getJob(jobId);
      // Уже терминальна (напр. параллельная отмена) — не трогаем и не
      // возвращаем квоту повторно.
      if (!current || TERMINAL_STATUSES.has(current.status)) return current;
      // Другая попытка уже в работе — старый callback ничего не делает.
      if ((current.enqueueSeq ?? 1) !== enqueueSeq) return current;

      // Возврат квоты одной операцией: reads-before-writes для Firestore.
      if (current.creditsSpent > 0) {
        await this.quota.refund(tx, {
          uid: current.uid,
          projectId: current.projectId,
          now: this.now(),
          count: current.creditsSpent,
        });
      }

      const now = this.now().toISOString();
      return tx.putJob({
        ...current,
        status: 'failed',
        phase: 'failed',
        progress: 0,
        message: 'Не удалось поставить анализ в очередь',
        error: {
          code: 'ANALYSIS_ENQUEUE_FAILED',
          message: 'Не удалось запустить анализ. Повторите попытку.',
          retryable: true,
        },
        creditsSpent: 0,
        updatedAt: now,
        finishedAt: now,
      });
    });
  }

  /** Просрочена ли `queued`-попытка: провисела дольше потолка ожидания (§4A.9). */
  #isQueueExpired(job) {
    const startedMs = Date.parse(job?.queuedAt ?? job?.createdAt ?? '');
    if (!Number.isFinite(startedMs)) return false;
    return this.now().getTime() - startedMs >= this.queueTimeoutMs;
  }

  /**
   * Watchdog очереди (§4A.9). Переводит ВСЁ ЕЩЁ `queued` попытку в терминальный
   * `failed` по таймауту ожидания: задача потеряна/не доставлена. Идемпотентно и
   * безопасно к гонкам — действует только если:
   *   • задача всё ещё `queued` (не стартовала, не отменена, не завершена);
   *   • это ТА ЖЕ попытка (`enqueueSeq` совпадает) — watchdog старой попытки
   *     после retry ничего не делает;
   *   • время ожидания действительно вышло (защита от раннего срабатывания).
   * Освобождает слот и возвращает кредит РОВНО ОДИН РАЗ. Публичный: его дёргает
   * reap-endpoint (отложенная Cloud Task) и защитная проверка при обращении.
   */
  async reapQueued(jobId, enqueueSeq) {
    return this.store.runTransaction(async (tx) => {
      const current = await tx.getJob(jobId);
      if (!current) return null;
      // Не queued → уже стартовала/терминальна: watchdog — no-op.
      if (current.status !== 'queued') return current;
      // Другая попытка уже в очереди → старый watchdog ничего не делает.
      if ((current.enqueueSeq ?? 1) !== enqueueSeq) return current;
      // Ещё не просрочена (раннее срабатывание) — не трогаем.
      if (!this.#isQueueExpired(current)) return current;

      if (current.creditsSpent > 0) {
        await this.quota.refund(tx, {
          uid: current.uid,
          projectId: current.projectId,
          now: this.now(),
          count: current.creditsSpent,
        });
      }

      const now = this.now().toISOString();
      this.logger?.warn?.('analysis queue timeout', { jobId, enqueueSeq });
      return tx.putJob({
        ...current,
        status: 'failed',
        phase: 'failed',
        progress: 0,
        message: 'Анализ не стартовал вовремя',
        error: {
          code: 'ANALYSIS_QUEUE_TIMEOUT',
          message: 'Анализ не удалось запустить. Повторите попытку.',
          retryable: true,
        },
        creditsSpent: 0,
        updatedAt: now,
        finishedAt: now,
      });
    });
  }

  /**
   * Планирует отложенный watchdog (§4A.9) для конкретной попытки. В облаке —
   * Cloud Task на reap-endpoint через `notBeforeMs`. Best-effort: сбой не
   * пробрасывается (защитную роль дублирует проверка просроченных queued).
   */
  async #scheduleWatchdog({ jobId, uid, projectId, enqueueSeq }) {
    if (!this.watchdogQueue) return;
    try {
      await this.watchdogQueue.enqueue({
        kind: 'analysis.reap',
        jobId,
        uid,
        projectId,
        enqueueSeq,
        notBeforeMs: this.queueTimeoutMs,
      });
    } catch (err) {
      this.logger?.warn?.('watchdog schedule failed', {
        jobId,
        enqueueSeq,
        detail: toApiError(err).detail,
      });
    }
  }

  /** Защитная проверка (§4A.9): добить просроченные `queued` попытки пользователя. */
  async #reapStaleForUser(uid) {
    const active = (await this.store.listActiveJobs?.(uid)) ?? [];
    for (const job of active) {
      if (job.status === 'queued' && this.#isQueueExpired(job)) {
        await this.reapQueued(job.id, job.enqueueSeq ?? 1);
      }
    }
  }

  /** Статус задачи с проверкой владения (§3). */
  async getAnalysis(uid, analysisId) {
    const job = await this.store.getJob(analysisId);
    // Одинаковая ошибка для чужого и несуществующего: иначе по коду ответа
    // можно перебором узнавать, какие идентификаторы существуют.
    if (!job || job.uid !== uid) {
      throw new ApiError('ANALYSIS_NOT_FOUND', 'Анализ не найден.');
    }
    // §4A.9: защитная проверка при обращении к задаче — просроченная `queued`
    // попытка добивается прямо здесь, чтобы клиент увидел терминальный статус, а
    // слот освободился, даже если отложенный watchdog не сработал.
    if (job.status === 'queued' && this.#isQueueExpired(job)) {
      const reaped = await this.reapQueued(analysisId, job.enqueueSeq ?? 1);
      if (reaped) return reaped;
    }
    return job;
  }

  /** Кооперативная отмена (§12). Возвращает квоту, если она была списана. */
  async cancelAnalysis(uid, analysisId) {
    const job = await this.getAnalysis(uid, analysisId);
    if (TERMINAL_STATUSES.has(job.status)) {
      throw new ApiError('ANALYSIS_ALREADY_TERMINAL', 'Анализ уже завершён.');
    }

    // Отмена в этом инстансе — сразу; отмена на другом инстансе (Cloud Tasks
    // мог запустить обработчик где угодно) обеспечивается тем, что цикл
    // runJob перечитывает статус задачи из хранилища на каждом материале.
    this.running.get(analysisId)?.abort();

    return this.store.runTransaction(async (tx) => {
      const current = await tx.getJob(analysisId);
      if (TERMINAL_STATUSES.has(current.status)) return current;

      // Возврат всех списанных кредитов ОДНОЙ операцией: цикл refund'ов дал бы
      // чтение после записи и сломал транзакцию Firestore.
      if (current.creditsSpent > 0) {
        await this.quota.refund(tx, {
          uid,
          projectId: current.projectId,
          now: this.now(),
          count: current.creditsSpent,
        });
      }

      const now = this.now().toISOString();
      return tx.putJob({
        ...current,
        status: 'cancelled',
        phase: 'cancelled',
        message: 'Анализ отменён',
        updatedAt: now,
        finishedAt: now,
        creditsSpent: 0,
      });
    });
  }

  /**
   * Повтор после ошибки (§12).
   *
   * Успешный анализ повторять нечего — возвращаем как есть. Неудачный
   * запускается заново, но материалы, которые уже разобраны, возьмутся из
   * кэша: платим только за то, что действительно осталось сделать.
   */
  async retryAnalysis(uid, analysisId, assets) {
    // Ownership/существование (getAnalysis попутно добьёт просроченную queued).
    const job = await this.getAnalysis(uid, analysisId);
    if (job.status === 'succeeded') return { job, isNew: false };

    // §4A.9: возрождение и инкремент попытки — АТОМАРНО в одной транзакции.
    //   • увеличиваем enqueueSeq → следующая задача получит НОВОЕ имя и не
    //     столкнётся с дедуп-tombstone завершённой попытки;
    //   • только из терминального failed/cancelled: два конкурентных retry
    //     сериализуются, второй увидит уже `queued` и будет отклонён — двух
    //     оплаченных попыток не возникает.
    const revived = await this.store.runTransaction(async (tx) => {
      const current = await tx.getJob(analysisId);
      if (!current || current.uid !== uid) {
        throw new ApiError('ANALYSIS_NOT_FOUND', 'Анализ не найден.');
      }
      if (current.status === 'succeeded') return { job: current, alreadyDone: true };
      if (!TERMINAL_STATUSES.has(current.status)) {
        // queued/running (в т.ч. из-за конкурентного retry) — уже выполняется.
        throw new ApiError('ANALYSIS_ALREADY_TERMINAL', 'Анализ ещё выполняется.');
      }

      const now = this.now().toISOString();
      const enqueueSeq = (current.enqueueSeq ?? 1) + 1;
      const next = await tx.putJob({
        ...current,
        status: 'queued',
        phase: 'queued',
        progress: 0,
        message: 'Повтор анализа',
        error: null,
        warnings: [],
        enqueueSeq,
        queuedAt: now,
        updatedAt: now,
        finishedAt: null,
      });
      return { job: next, alreadyDone: false };
    });

    if (revived.alreadyDone) return { job: revived.job, isNew: false };

    const dispatched = await this.#dispatch({
      job: revived.job,
      uid,
      projectId: job.projectId,
      assets,
    });
    return { job: dispatched.job, isNew: true };
  }

  /** Обновление прогресса — безопасное: наружу не уходит ничего лишнего (§6). */
  async #progress(jobId, phase, fraction, message) {
    return this.store.runTransaction(async (tx) => {
      const job = await tx.getJob(jobId);
      if (!job || TERMINAL_STATUSES.has(job.status)) return job;

      const spec = ANALYSIS_PHASES[phase] ?? ANALYSIS_PHASES.queued;
      const next = progressFor(phase, fraction);

      return tx.putJob({
        ...job,
        status: spec.status,
        phase,
        // Прогресс не убывает: полоса в UI не должна дёргаться назад.
        progress: Math.max(job.progress, next),
        message: message ?? job.message,
        updatedAt: this.now().toISOString(),
      });
    });
  }

  async #isCancelled(jobId) {
    const job = await this.store.getJob(jobId);
    return !job || TERMINAL_STATUSES.has(job.status);
  }

  /**
   * Основной проход анализа — публичный: его вызывает очередь (§4A.7), а в
   * облаке — внутренний OIDC-endpoint по задаче Cloud Tasks.
   *
   * Идемпотентность повтора (§4A.7): уже завершённая задача — no-op; уже
   * разобранный материал берётся из кэша по хешу содержимого, поэтому Gemini
   * повторно не вызывается и квота не списывается.
   *
   * Исчерпание повторов: при retryable-сбое и не последней попытке ошибка
   * пробрасывается (очередь повторит); на последней попытке фиксируется
   * безопасное терминальное состояние `failed`.
   */
  async runJob(jobId, { uid, projectId, assets, attempt = 0, maxAttempts = 1 }) {
    const existing = await this.store.getJob(jobId);
    if (!existing || TERMINAL_STATUSES.has(existing.status)) return; // идемпотентно
    if (existing.uid !== uid) return; // чужую задачу не трогаем

    const controller = new AbortController();
    this.running.set(jobId, controller);

    const budget = new CostBudget();
    const analyses = [];
    const warnings = [];
    let credits = 0;
    let fromCacheCount = 0;

    try {
      await this.#progress(jobId, 'probing', 0, 'Проверка материалов');

      for (const [index, asset] of assets.entries()) {
        if ((await this.#isCancelled(jobId)) || controller.signal.aborted) {
          throw new ApiError('CANCELLED', 'Анализ отменён.');
        }

        const share = index / assets.length;
        await this.#progress(jobId, 'probing', share, 'Проверка материалов');

        // Локальный проход: ffprobe, сцены, качество, кадры, аудио. uid/projectId
        // передаём для ПОВТОРНОЙ проверки владения в media adapter перед чтением
        // из GCS. Временный файл материала гарантированно освобождается в finally
        // (media.release) — при успехе, кэш-попадании, ошибке, отмене и таймауте.
        let measured;
        try {
          measured = await this.media.measure(asset, { signal: controller.signal, uid, projectId });

          // §5: ключ кэша — от содержимого, посчитанного сервером.
          const fingerprint = analysisFingerprint({
            uid,
            contentHash: measured.contentHash,
            analysisVersion: 1,
            model: this.gemini?.model ?? 'none',
          });

          const cached = await this.store.getAnalysis(fingerprint);
          if (cached) {
            // Кэш-попадание: ни вызова модели, ни списания квоты.
            analyses.push(cached);
            fromCacheCount += 1;
            await this.#progress(jobId, 'sampling', (index + 1) / assets.length, 'Материал уже разобран');
            continue;
          }

          await this.#progress(jobId, 'sampling', share, 'Отбор кадров');
          const sample = await this.media.sample(asset, measured, {
            signal: controller.signal,
            uid,
            projectId,
          });

          if (!budget.canAfford({ frames: sample.frames.length, audioSeconds: sample.audioSeconds })) {
            warnings.push(`Материал «${asset.id}» пропущен: исчерпан бюджет анализа.`);
            continue;
          }

          // Квота списывается ровно перед платной работой и в одной транзакции.
          await this.store.runTransaction(async (tx) => {
            // Все чтения ДО записей (getJob, затем чтения счётчиков внутри
            // charge) — требование транзакций Firestore.
            const job = await tx.getJob(jobId);
            await this.quota.charge(tx, { uid, projectId, now: this.now() });
            await tx.putJob({ ...job, creditsSpent: (job.creditsSpent ?? 0) + 1 });
          });
          credits += 1;

          await this.#progress(jobId, 'understanding', share, 'Анализ содержимого');
          const analysis = await this.#analyseAsset({
            asset,
            measured,
            sample,
            budget,
            signal: controller.signal,
          });

          await this.store.putAnalysis(fingerprint, analysis);
          analyses.push(analysis);

          await this.#progress(
            jobId,
            'understanding',
            (index + 1) / assets.length,
            'Анализ содержимого',
          );
        } finally {
          // Освобождаем скачанный адаптером временный файл этого материала.
          // release опционален (fakeMedia его не имеет) и не должен маскировать
          // основную ошибку.
          if (measured !== undefined && typeof this.media.release === 'function') {
            try {
              await this.media.release(measured);
            } catch (cleanupErr) {
              this.logger?.warn?.('media release failed', {
                jobId,
                stage: 'release',
                code: cleanupErr?.code ?? 'unknown',
              });
            }
          }
        }
      }

      if (analyses.length === 0) {
        throw new ApiError('ANALYSIS_FAILED', 'Не удалось разобрать ни один материал.');
      }

      const now = this.now().toISOString();
      await this.store.runTransaction(async (tx) => {
        const job = await tx.getJob(jobId);
        if (TERMINAL_STATUSES.has(job.status)) return job;

        return tx.putJob({
          ...job,
          status: 'succeeded',
          phase: 'done',
          progress: 1,
          message: 'Анализ готов',
          updatedAt: now,
          finishedAt: now,
          analyses,
          warnings,
          assetsAnalyzed: analyses.length,
          creditsSpent: credits,
          fromCache: fromCacheCount === assets.length,
          costUsd: budget.snapshot().usd,
        });
      });

      this.logger?.info?.('analysis finished', {
        jobId,
        assets: analyses.length,
        credits,
        fromCache: fromCacheCount,
        ...budget.snapshot(),
      });
    } catch (err) {
      const api = toApiError(err);
      const cancelled = api.code === 'CANCELLED' || (await this.#isCancelled(jobId));

      // §4A.7: retryable-сбой на НЕ последней попытке — пробрасываем, чтобы
      // очередь повторила задачу (job остаётся в running, прогресс сохранён).
      // Отмена и не-retryable ошибки повторять бессмысленно.
      const lastAttempt = attempt >= maxAttempts - 1;
      if (!cancelled && api.retryable && !lastAttempt) {
        this.running.delete(jobId);
        this.logger?.warn?.('analysis attempt failed, will retry', {
          jobId,
          attempt,
          code: api.code,
        });
        throw err;
      }

      await this.store.runTransaction(async (tx) => {
        const job = await tx.getJob(jobId);
        if (!job || TERMINAL_STATUSES.has(job.status)) return job;

        const now = this.now().toISOString();
        return tx.putJob({
          ...job,
          status: cancelled ? 'cancelled' : 'failed',
          phase: cancelled ? 'cancelled' : 'failed',
          message: cancelled ? 'Анализ отменён' : 'Анализ не удался',
          // Наружу — только код и безопасное сообщение (§6).
          error: cancelled ? null : { code: api.code, message: api.message, retryable: api.retryable },
          warnings,
          updatedAt: now,
          finishedAt: now,
        });
      });

      this.logger?.warn?.('analysis failed', { jobId, code: api.code, detail: api.detail });
    } finally {
      this.running.delete(jobId);
    }
  }

  /** Разбор одного материала моделью: кадры, затем при необходимости речь. */
  async #analyseAsset({ asset, measured, sample, budget, signal }) {
    if (!this.gemini) {
      throw new ApiError('ANALYSIS_UNAVAILABLE', 'Анализ недоступен: ИИ не настроен на сервере.');
    }

    const prompt = buildAnalysisPrompt({ asset, measured });
    const parts = [
      { text: prompt.user },
      ...sample.frames.map((frame) => ({
        inlineData: { mimeType: frame.mimeType, data: frame.data },
      })),
    ];

    const vision = await this.gemini.generateJson({
      system: prompt.system,
      parts,
      schema: GEMINI_ANALYSIS_SCHEMA,
      signal,
    });
    budget.charge({
      frames: sample.frames.length,
      promptTokens: vision.usage.promptTokens,
      outputTokens: vision.usage.outputTokens,
    });

    let speech = null;
    if (sample.audio) {
      const speechPrompt = buildSpeechPrompt({ language: asset.language });
      const result = await this.gemini.generateJson({
        system: speechPrompt.system,
        parts: [
          { text: speechPrompt.user },
          { inlineData: { mimeType: sample.audio.mimeType, data: sample.audio.data } },
        ],
        schema: GEMINI_SPEECH_SCHEMA,
        signal,
      });
      budget.charge({
        audioSeconds: sample.audioSeconds,
        promptTokens: result.usage.promptTokens,
        outputTokens: result.usage.outputTokens,
      });
      speech = result.json;
    }

    // §7: результат модели проходит строгую валидацию до того, как попадёт
    // куда-либо ещё. Технические характеристики — измеренные, не от модели.
    return validateMediaAnalysis(
      { ...vision.json, speech },
      {
        assetId: asset.id,
        type: asset.type,
        durationSeconds: measured.durationSeconds,
        width: measured.width,
        height: measured.height,
      },
    );
  }
}
