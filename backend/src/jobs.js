// Сервис задач рендера: создание (с защитой от дубликатов), состояние,
// отмена, ссылки на скачивание и приём прогресса от worker'а.
//
// Реализует docs/render-contract.md §4, §5, §8.

import {
  CONTRACT_VERSION,
  MAX_ACTIVE_JOBS_PER_PROJECT,
  PHASES,
  TERMINAL_STATUSES,
  buildFingerprint,
  canTransition,
  newId,
  jobPrefix,
  outputPrefix,
  outputVideoPath,
  planPath,
  progressFor,
  projectPrefix,
  thumbnailPath,
  userPrefix,
  validateRenderRequest,
} from './contract.js';
import { ApiError, jobError } from './errors.js';
import { validateProjectMedia } from './media-validation.js';
import { creditCostFor } from './quota.js';

const MESSAGES = {
  queued: 'Задача в очереди',
  preparing: 'Подготовка плана',
  downloading: 'Загрузка материалов',
  rendering: 'Монтаж и субтитры',
  encoding: 'Кодирование видео',
  uploading: 'Выгрузка результата',
  finalizing: 'Завершение',
  done: 'Готово',
  failed: 'Ошибка рендера',
  cancelled: 'Отменено',
};

/** Внутренние поля, которые клиент не должен видеть. */
const INTERNAL_FIELDS = new Set([
  'executionName',
  'fingerprint',
  'contentHash',
  'planObjectPath',
  'outputPrefix',
  'projectPrefix',
  'jobPrefix',
  'ownerUid',
  'charge',
  'ip',
  'plan',
  'assets',
]);

/** Публичное представление RenderJob (§4). */
export function toPublicJob(job) {
  const out = {};
  for (const [k, v] of Object.entries(job)) {
    if (!INTERNAL_FIELDS.has(k)) out[k] = v;
  }
  return out;
}

export class RenderJobService {
  constructor({ config, store, storage, runner, quota = null }) {
    this.config = config;
    this.store = store;
    this.storage = storage;
    this.runner = runner;
    this.quota = quota;
  }

  #now() {
    return new Date().toISOString();
  }

  #expiresAt(fromIso) {
    const ms = new Date(fromIso).getTime() + this.config.render.jobTtlDays * 86_400_000;
    return new Date(ms).toISOString();
  }

  #progressUrl(jobId) {
    const base = this.config.render.publicBaseUrl || `http://127.0.0.1:${this.config.port}`;
    return `${base}/internal/jobs/${jobId}/progress`;
  }

  // ── Создание задачи ─────────────────────────────────────────────────────

  /**
   * POST /render. Возвращает { job, created } — created=false означает
   * идемпотентный дубликат (§5), HTTP 200 вместо 202.
   */
  async createJob(body, { idempotencyKey, ownerUid, ip } = {}) {
    const validated = validateRenderRequest(body, ownerUid);
    validated.ownerUid = ownerUid;
    validated.ip = ip || null;
    // Владелец входит в отпечаток: одинаковые планы разных пользователей —
    // это разные задачи, а не дубликат.
    const { fingerprint, contentHash } = buildFingerprint({
      ...validated,
      projectId: `${ownerUid}/${validated.projectId}`,
      idempotencyKey,
    });

    const jobId = newId('job');
    const reservation = await this.store.reserveFingerprint(fingerprint, {
      fingerprint,
      jobId,
      contentHash,
      createdAt: this.#now(),
    });

    if (!reservation.created) {
      const record = reservation.record;
      const existing = record.jobId ? await this.store.getJob(record.jobId) : null;

      if (existing) {
        // Тот же ключ, другой контент — сознательная ошибка клиента (§5.4).
        if (record.contentHash !== contentHash) {
          throw new ApiError(
            'IDEMPOTENCY_KEY_REUSED',
            'Ключ идемпотентности уже использован с другим содержимым запроса.',
            { jobId: existing.jobId },
          );
        }

        const checked = await this.#failIfStale(existing);

        // Активная или успешная задача переиспользуется как есть (§5.1, §5.2).
        if (!TERMINAL_STATUSES.has(checked.status) || checked.status === 'succeeded') {
          return { job: await this.#withFreshResult(checked), created: false };
        }

        // failed / cancelled → новая попытка (§5.3).
        return {
          job: await this.#spawnJob(validated, {
            jobId,
            fingerprint,
            contentHash,
            attempt: (checked.attempt || 1) + 1,
          }),
          created: true,
        };
      }

      // Отпечаток есть, задачи нет (истёк TTL) — перепривязываем.
      await this.store.rebindFingerprint(fingerprint, {
        fingerprint,
        jobId,
        contentHash,
        createdAt: this.#now(),
      });
    }

    return {
      job: await this.#spawnJob(validated, { jobId, fingerprint, contentHash, attempt: 1 }),
      created: true,
    };
  }

  async #spawnJob(validated, { jobId, fingerprint, contentHash, attempt }) {
    const { projectId, plan, assets, export: exp, ownerUid, ip } = validated;

    // Содержимое проверяется до кредита и до запуска Job'а: платить за рендер
    // заведомо негодного материала не должен ни пользователь, ни мы.
    if (this.config.media?.verify) {
      const media = await validateProjectMedia({
        assets,
        storage: this.storage,
        limits: this.config.limits,
        ffprobePath: this.config.media.ffprobePath,
      });
      // Характеристики берём из файла, а не со слов клиента: от них зависит
      // резолв разрешения и оценка размера.
      for (const asset of assets) {
        const info = media.byAssetId[asset.id];
        if (!info) continue;
        asset.type = info.type;
        asset.width = info.width;
        asset.height = info.height;
        asset.durationSeconds = info.durationSeconds;
        asset.sizeBytes = info.sizeBytes;
      }
    }

    const [activeUser, activeGlobal] = await Promise.all([
      this.store.countActiveJobs(ownerUid),
      this.store.countActiveJobsGlobal(),
    ]);

    // Квота и кредиты списываются здесь, до запуска платной работы. Списание
    // атомарно, поэтому параллельные запросы не проскочат мимо лимита.
    let charge = null;
    if (this.quota) {
      charge = await this.store.runTransaction((tx) =>
        this.quota.reserveRender(tx, {
          uid: ownerUid,
          ip,
          cost: creditCostFor(exp.resolution),
          activeUser,
          activeGlobal,
        }),
      );
    }

    const createdAt = this.#now();
    const job = {
      contractVersion: CONTRACT_VERSION,
      jobId,
      projectId,
      planId: plan.id,
      status: 'queued',
      phase: 'queued',
      progress: 0,
      message: MESSAGES.queued,
      export: exp,
      attempt,
      createdAt,
      updatedAt: createdAt,
      startedAt: null,
      finishedAt: null,
      expiresAt: this.#expiresAt(createdAt),
      result: null,
      error: null,
      cancelRequested: false,
      // Внутреннее — наружу не отдаётся.
      fingerprint,
      contentHash,
      executionName: null,
      ownerUid,
      charge,
      ip,
      planObjectPath: planPath(ownerUid, projectId, jobId),
      outputPrefix: outputPrefix(ownerUid, projectId, jobId),
      projectPrefix: projectPrefix(ownerUid, projectId),
      jobPrefix: jobPrefix(ownerUid, projectId, jobId),
    };

    await this.store.createJob(job);

    // Снимок плана — единственный вход worker'а (§6).
    const planUri = await this.storage.writeJson(
      job.planObjectPath,
      {
        contractVersion: CONTRACT_VERSION,
        jobId,
        projectId,
        plan,
        assets,
        export: exp,
        output: {
          prefix: job.outputPrefix,
          videoObjectPath: outputVideoPath(ownerUid, projectId, jobId, exp.height),
          thumbnailObjectPath: thumbnailPath(ownerUid, projectId, jobId),
        },
        createdAt,
      },
      { jobId, projectId, planId: plan.id, contractVersion: String(CONTRACT_VERSION) },
      // Снимок плана живёт ровно столько же, сколько результат задачи.
      { customTime: job.expiresAt },
    );

    let executionName = null;
    try {
      executionName = await this.runner.start({
        job,
        planUri,
        bucket: this.config.render.bucket,
        progressUrl: this.#progressUrl(jobId),
        workerToken: this.config.render.workerToken,
      });
    } catch (e) {
      const failed = await this.#patch(jobId, (j) => ({
        ...j,
        status: 'failed',
        phase: 'failed',
        finishedAt: this.#now(),
        updatedAt: this.#now(),
        message: MESSAGES.failed,
        error: jobError('RENDER_UNAVAILABLE', 'Не удалось запустить обработчик рендера.'),
      }));
      console.error(`[job ${jobId}] runner start failed: ${e?.status || e?.code || 'ERR'}`);
      return failed;
    }

    if (!executionName) {
      // Обработчик не настроен: задача честно остаётся в очереди, а не «падает».
      return this.#patch(jobId, (j) => ({
        ...j,
        message: 'Ожидание обработчика рендера',
        updatedAt: this.#now(),
      }));
    }

    return this.#patch(jobId, (j) => ({ ...j, executionName, updatedAt: this.#now() }));
  }

  #patch(jobId, mutate) {
    return this.store.updateJob(jobId, mutate);
  }

  // ── Чтение состояния ────────────────────────────────────────────────────

  /**
   * Чужая задача обязана быть НЕОТЛИЧИМА от несуществующей: одинаковый код,
   * одинаковый текст. Иначе перебором jobId можно выяснить, какие задачи
   * существуют у других пользователей.
   */
  #assertOwner(job, ownerUid, jobId) {
    if (!job || (ownerUid && job.ownerUid && job.ownerUid !== ownerUid)) {
      throw new ApiError('JOB_NOT_FOUND', 'Задача рендера не найдена.', { jobId });
    }
    return job;
  }

  async getJob(jobId, ownerUid) {
    const job = this.#assertOwner(await this.store.getJob(jobId), ownerUid, jobId);
    return this.#withFreshResult(await this.#failIfStale(job));
  }

  /** Зависшая задача (нет heartbeat > таймаута) переводится в failed (§4.2). */
  async #failIfStale(job) {
    if (TERMINAL_STATUSES.has(job.status)) return job;
    const age = Date.now() - new Date(job.updatedAt).getTime();
    if (age < this.config.render.heartbeatTimeoutMs) return job;

    const now = this.#now();
    return (
      (await this.#patch(job.jobId, (j) => {
        if (TERMINAL_STATUSES.has(j.status)) return null;
        return {
          ...j,
          status: 'failed',
          phase: 'failed',
          updatedAt: now,
          finishedAt: now,
          message: MESSAGES.failed,
          error: jobError('WORKER_TIMEOUT', 'Обработчик рендера не отвечает.'),
        };
      })) || job
    );
  }

  /** Для успешной задачи выдаёт свежий signed URL (§8). */
  async #withFreshResult(job) {
    if (job.status !== 'succeeded' || !job.result?.objectPath) return job;
    if (new Date(job.expiresAt).getTime() <= Date.now()) return job;
    try {
      const [video, thumb] = await Promise.all([
        this.storage.signedReadUrl(job.result.objectPath, {
          fileName: this.#fileName(job),
        }),
        job.result.thumbnailObjectPath
          ? this.storage.signedReadUrl(job.result.thumbnailObjectPath)
          : Promise.resolve(null),
      ]);
      return {
        ...job,
        result: {
          ...job.result,
          downloadUrl: video.url,
          downloadUrlExpiresAt: video.expiresAt,
          thumbnailUrl: thumb?.url ?? null,
        },
      };
    } catch {
      // Подпись недоступна — отдаём задачу без ссылки, клиент дёрнет /download.
      return job;
    }
  }

  #fileName(job) {
    return `reelio_${job.export?.height || 1920}p_${job.jobId}.mp4`;
  }

  // ── Отмена ──────────────────────────────────────────────────────────────

  async cancelJob(jobId, ownerUid) {
    const existing = this.#assertOwner(await this.store.getJob(jobId), ownerUid, jobId);

    // Повторная отмена идемпотентна, отмена завершённой — конфликт (§8).
    if (existing.status === 'cancelled') return existing;
    if (TERMINAL_STATUSES.has(existing.status)) {
      throw new ApiError(
        'JOB_ALREADY_TERMINAL',
        'Задача уже завершена, отмена невозможна.',
        { jobId },
      );
    }

    const stopped = await this.runner.cancel(existing.executionName);
    const now = this.#now();

    // Отменённая работа не должна стоить кредита: пользователь сам её прекратил.
    if (this.quota && existing.charge) {
      try {
        await this.quota.refundRender(existing.charge);
      } catch {
        // Возврат — не повод провалить отмену. Хуже не вернуть кредит, чем
        // оставить пользователя с неостановленным платным рендером.
        console.warn(`[job ${jobId}] credit refund failed`);
      }
    }

    // queued (worker ещё не стартовал) или execution снят — закрываем сразу.
    // Иначе оставляем флаг: worker увидит его в ответе на heartbeat (§8.1).
    const finalize = stopped || existing.status === 'queued';

    return this.#patch(jobId, (j) => {
      if (TERMINAL_STATUSES.has(j.status)) return null;
      if (!finalize) return { ...j, cancelRequested: true, updatedAt: now };
      return {
        ...j,
        cancelRequested: true,
        status: 'cancelled',
        phase: 'cancelled',
        updatedAt: now,
        finishedAt: now,
        message: MESSAGES.cancelled,
        error: jobError('CANCELLED_BY_USER', 'Рендер отменён пользователем.'),
      };
    });
  }

  // ── Скачивание ──────────────────────────────────────────────────────────

  async downloadInfo(jobId, ownerUid) {
    const job = await this.getJob(jobId, ownerUid);

    if (job.status !== 'succeeded' || !job.result?.objectPath) {
      throw new ApiError(
        'RESULT_NOT_READY',
        'Результат ещё не готов.',
        { jobId, retryable: !TERMINAL_STATUSES.has(job.status) },
      );
    }
    if (new Date(job.expiresAt).getTime() <= Date.now()) {
      throw new ApiError('RESULT_EXPIRED', 'Срок хранения результата истёк.', { jobId });
    }
    if (!(await this.storage.exists(job.result.objectPath))) {
      throw new ApiError('RESULT_EXPIRED', 'Файл результата больше недоступен.', { jobId });
    }

    const fileName = this.#fileName(job);
    const { url, expiresAt } = await this.storage.signedReadUrl(job.result.objectPath, { fileName });
    return {
      downloadUrl: url,
      expiresAt,
      sizeBytes: job.result.sizeBytes ?? null,
      fileName,
      jobId,
    };
  }

  // ── Удаление данных пользователя ────────────────────────────────────────

  /**
   * Удаляет проект целиком: исходники, планы, результаты и записи задач.
   *
   * Активные задачи сначала отменяются — иначе worker продолжит писать в
   * каталог, который мы только что вычистили, и оставит мусор.
   */
  async deleteProject(ownerUid, projectId) {
    const jobs = await this.store.listJobsByOwner(ownerUid, projectId);

    for (const job of jobs) {
      if (!TERMINAL_STATUSES.has(job.status)) {
        try {
          await this.cancelJob(job.jobId, ownerUid);
        } catch {
          // Гонка со штатным завершением — не повод прерывать удаление.
        }
      }
    }

    const objects = await this.storage.deletePrefix(projectPrefix(ownerUid, projectId));
    await Promise.all(jobs.map((j) => this.store.deleteJob(j.jobId)));

    return { jobs: jobs.length, objects };
  }

  /** Удаляет все данные пользователя (перед удалением учётной записи). */
  async deleteAccountData(ownerUid) {
    const jobs = await this.store.listJobsByOwner(ownerUid);

    for (const job of jobs) {
      if (!TERMINAL_STATUSES.has(job.status)) {
        try {
          await this.cancelJob(job.jobId, ownerUid);
        } catch {
          /* см. выше */
        }
      }
    }

    const objects = await this.storage.deletePrefix(userPrefix(ownerUid));
    await Promise.all(jobs.map((j) => this.store.deleteJob(j.jobId)));

    return { jobs: jobs.length, objects };
  }

  // ── Прогресс от worker'а (§8.1) ─────────────────────────────────────────

  async applyProgress(jobId, payload) {
    const phase = payload?.phase;
    if (!PHASES[phase]) {
      throw new ApiError('INVALID_REQUEST', `Неизвестный этап «${phase}».`, { field: 'phase' });
    }

    const current = await this.store.getJob(jobId);
    if (!current) throw new ApiError('JOB_NOT_FOUND', 'Задача рендера не найдена.', { jobId });
    if (TERMINAL_STATUSES.has(current.status)) {
      throw new ApiError('JOB_ALREADY_TERMINAL', 'Задача уже завершена.', { jobId });
    }

    const nextStatus = PHASES[phase].status;
    if (!canTransition(current.status, nextStatus)) {
      throw new ApiError(
        'JOB_ALREADY_TERMINAL',
        `Переход ${current.status} → ${nextStatus} недопустим.`,
        { jobId },
      );
    }

    const result = phase === 'done' ? await this.#normalizeResult(current, payload.result) : null;
    const now = this.#now();
    const message =
      typeof payload.message === 'string' && payload.message
        ? payload.message.slice(0, 200)
        : MESSAGES[phase];

    const updated = await this.#patch(jobId, (j) => {
      if (TERMINAL_STATUSES.has(j.status)) return null;

      const proposed = progressFor(phase, payload.fraction);
      const next = {
        ...j,
        status: nextStatus,
        phase,
        // progress не убывает (§4).
        progress: phase === 'done' ? 1 : Math.max(j.progress || 0, proposed),
        message,
        updatedAt: now,
        startedAt: j.startedAt || (nextStatus === 'running' ? now : null),
      };

      if (phase === 'done') {
        next.result = result;
        next.finishedAt = now;
        next.error = null;
      } else if (phase === 'failed') {
        next.finishedAt = now;
        next.error = jobError(
          payload.error?.code || 'WORKER_FAILED',
          payload.error?.message?.slice(0, 300) || 'Обработчик рендера завершился с ошибкой.',
        );
      } else if (phase === 'cancelled') {
        next.finishedAt = now;
        next.error = jobError('CANCELLED_BY_USER', 'Рендер отменён пользователем.');
      }
      return next;
    });

    return {
      ok: true,
      status: updated?.status ?? current.status,
      cancelRequested: Boolean(updated?.cancelRequested),
    };
  }

  /**
   * Доверять worker'у на слово нельзя: путь обязан лежать внутри output-префикса
   * задачи, а файл — реально существовать. Размер и контрольную сумму берём из
   * хранилища, а не из отчёта.
   */
  async #normalizeResult(job, raw) {
    const objectPath =
      raw?.objectPath || outputVideoPath(job.ownerUid, job.projectId, job.jobId, job.export.height);
    if (!objectPath.startsWith(job.outputPrefix + '/')) {
      throw new ApiError(
        'INVALID_OBJECT_PATH',
        'Путь результата вне каталога задачи.',
        { jobId: job.jobId, field: 'result.objectPath' },
      );
    }
    if (!(await this.storage.exists(objectPath))) {
      throw new ApiError('INVALID_REQUEST', 'Файл результата не найден в хранилище.', {
        jobId: job.jobId,
        field: 'result.objectPath',
      });
    }

    const stat = await this.storage.statObject(objectPath);

    let thumbnailObjectPath =
      raw?.thumbnailObjectPath ?? thumbnailPath(job.ownerUid, job.projectId, job.jobId);
    if (!thumbnailObjectPath.startsWith(job.outputPrefix + '/') || !(await this.storage.exists(thumbnailObjectPath))) {
      thumbnailObjectPath = null;
    }

    // Помечаем артефакты сроком годности задачи: lifecycle удалит их ровно по
    // expiresAt, а не «когда-нибудь через 30 дней» (§6).
    for (const path of [objectPath, thumbnailObjectPath]) {
      if (!path) continue;
      try {
        await this.storage.setCustomTime(path, job.expiresAt);
      } catch {
        // Не критично: остаётся 30-дневный предохранитель. Задачу не валим.
        console.warn(`[job ${job.jobId}] custom time not set`);
      }
    }

    return {
      objectPath,
      thumbnailObjectPath,
      sizeBytes: stat.sizeBytes,
      durationSeconds: Number(raw?.durationSeconds) || null,
      width: Number(raw?.width) || job.export.width,
      height: Number(raw?.height) || job.export.height,
      fps: Number(raw?.fps) || job.export.fps,
      videoCodec: raw?.videoCodec || 'h264',
      audioCodec: raw?.audioCodec || 'aac',
      checksumCrc32c: stat.checksumCrc32c,
      renderedAt: this.#now(),
      // Ссылки подписываются на каждом чтении и в хранилище состояния не живут.
      downloadUrl: null,
      downloadUrlExpiresAt: null,
      thumbnailUrl: null,
    };
  }
}
