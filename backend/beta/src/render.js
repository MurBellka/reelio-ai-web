// Render API v2 (§4B). Полный конвейер: signed uploads → задача рендера →
// запуск ТОЛЬКО worker-v2 → приём прогресса → выдача результата по
// короткоживущей ссылке.
//
// Инварианты, за которые отвечает этот модуль:
//   • пути строит СЕРВЕР из проверенного uid и projectId — клиентский
//     objectPath не используется для записи (§4B.2);
//   • запускается исключительно reelio-ffmpeg-worker-v2; EditPlan v2 никогда
//     не попадает в worker v1 (§4B.4, правило 1);
//   • состояние задач, идемпотентность, отмена и expiresAt живут в Store
//     (Firestore в облаке) (§4B.3);
//   • прогресс принимает только внутренний endpoint с токеном worker'а.
//
// Облачные адаптеры (подпись URL, запуск Job) грузятся динамически и
// подставляются фейками в тестах.

import { ApiError } from './errors.js';
import { assertOwnedPath, projectPrefixFor } from './auth.js';
import { TERMINAL_STATUSES, newId, requestFingerprint, sha256 } from './store.js';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Фазы рендера и их вклад в прогресс — как в контракте (§4.2). */
const RENDER_PHASES = {
  queued: { status: 'queued', from: 0, to: 0.05 },
  preparing: { status: 'running', from: 0.05, to: 0.1 },
  downloading: { status: 'running', from: 0.1, to: 0.3 },
  rendering: { status: 'running', from: 0.3, to: 0.6 },
  encoding: { status: 'running', from: 0.6, to: 0.9 },
  uploading: { status: 'running', from: 0.9, to: 0.98 },
  finalizing: { status: 'running', from: 0.98, to: 1 },
  done: { status: 'succeeded', from: 1, to: 1 },
  failed: { status: 'failed', from: 0, to: 1 },
  cancelled: { status: 'cancelled', from: 0, to: 1 },
};

/** Пути объектов задачи — строятся СЕРВЕРОМ (§6, §4B.2). */
export function renderPaths(uid, projectId, jobId) {
  const projectPrefix = projectPrefixFor(uid, projectId);
  const jobPrefix = `${projectPrefix}jobs/${jobId}/`;
  return {
    projectPrefix,
    jobPrefix,
    outputPrefix: `${jobPrefix}output/`,
    outputPath: `${jobPrefix}output/reel.mp4`,
    thumbnailPath: `${jobPrefix}output/thumbnail.jpg`,
    planPath: `${jobPrefix}plan.json`,
  };
}

const EXT_BY_CONTENT_TYPE = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

function sourceExt(asset) {
  return EXT_BY_CONTENT_TYPE[asset.contentType] ?? (asset.type === 'photo' ? 'jpg' : 'mp4');
}

/** Публичное представление задачи рендера — форма RenderJob контракта. */
export function toPublicRenderJob(job) {
  return {
    contractVersion: 2,
    jobId: job.id,
    projectId: job.projectId,
    planId: job.planId ?? null,
    status: job.status,
    phase: job.phase,
    progress: job.progress,
    message: job.message ?? '',
    export: job.export,
    attempt: job.attempt ?? 1,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt ?? null,
    finishedAt: job.finishedAt ?? null,
    expiresAt: job.expiresAt ?? null,
    cancelRequested: Boolean(job.cancelRequested),
    result: job.result ?? null,
    error: job.error ?? null,
  };
}

export class RenderService {
  /**
   * @param {{store, config, signer, jobs, logger?, now?}} deps
   *   signer.uploadUrl({bucket, objectPath, contentType, ttlSeconds}) → {url, headers, expiresAt}
   *   signer.downloadUrl({bucket, objectPath, ttlSeconds, fileName}) → {url, expiresAt}
   *   signer.writeJson({bucket, objectPath, data}) → void
   *   jobs.launch({jobName, region, env}) → {execution}
   *   jobs.cancel?({execution}) → void
   */
  constructor(deps) {
    this.store = deps.store;
    this.config = deps.config;
    this.signer = deps.signer;
    this.jobs = deps.jobs;
    this.logger = deps.logger ?? null;
    this.now = deps.now ?? (() => new Date());
  }

  get #bucket() {
    return this.config.storage.bucket;
  }

  #assertConfigured() {
    if (!this.signer || !this.jobs || !this.#bucket) {
      throw new ApiError('RENDER_NOT_CONFIGURED', 'Рендер временно недоступен.');
    }
  }

  // ── POST /uploads ─────────────────────────────────────────────────────────
  async createUploads({ uid, projectId, assets }) {
    this.#assertConfigured();
    if (!ID_RE.test(projectId)) {
      throw new ApiError('INVALID_REQUEST', 'Некорректный projectId.', { field: 'projectId' });
    }
    if (!Array.isArray(assets) || assets.length === 0) {
      throw new ApiError('INVALID_REQUEST', 'Не переданы материалы.', { field: 'assets' });
    }

    const ttl = this.config.storage.signedUrlTtlSeconds;
    const uploads = [];
    for (const [i, asset] of assets.entries()) {
      const field = `assets[${i}]`;
      if (!asset || !ID_RE.test(asset.id ?? '')) {
        throw new ApiError('INVALID_REQUEST', 'Некорректный идентификатор материала.', { field });
      }
      if (asset.type !== 'video' && asset.type !== 'photo') {
        throw new ApiError('INVALID_REQUEST', 'Тип материала должен быть video или photo.', { field });
      }
      // Путь строит СЕРВЕР из проверенного uid/projectId — клиентский objectPath
      // для записи не используется.
      const objectPath = `${projectPrefixFor(uid, projectId)}sources/${asset.id}.${sourceExt(asset)}`;
      const contentType = typeof asset.contentType === 'string' ? asset.contentType : 'application/octet-stream';
      const signed = await this.signer.uploadUrl({
        bucket: this.#bucket,
        objectPath,
        contentType,
        ttlSeconds: ttl,
      });
      uploads.push({
        assetId: asset.id,
        objectPath,
        uploadUrl: signed.url,
        method: 'PUT',
        headers: signed.headers ?? { 'Content-Type': contentType },
        expiresAt: signed.expiresAt,
      });
    }
    return { uploads };
  }

  // ── POST /render ──────────────────────────────────────────────────────────
  async submitRender({ uid, projectId, plan, assets, exportResolution, exportFps, idempotencyKey }) {
    this.#assertConfigured();
    if (!ID_RE.test(projectId)) {
      throw new ApiError('INVALID_REQUEST', 'Некорректный projectId.', { field: 'projectId' });
    }
    if (!plan || typeof plan !== 'object' || !Array.isArray(plan.clips) || plan.clips.length === 0) {
      throw new ApiError('PLAN_INVALID', 'Монтажный план пуст или некорректен.', { field: 'plan' });
    }
    if (!Array.isArray(assets) || assets.length === 0) {
      throw new ApiError('ASSET_MISSING', 'Не переданы материалы для рендера.', { field: 'assets' });
    }
    // §4B.2: каждый objectPath обязан лежать в префиксе ЭТОГО пользователя.
    for (const [i, asset] of assets.entries()) {
      assertOwnedPath(asset?.objectPath, uid, projectId, `assets[${i}].objectPath`);
    }

    const contentHash = sha256(
      JSON.stringify({ plan, assets: assets.map((a) => a.objectPath).sort() }),
    );
    const fingerprint = requestFingerprint({ uid, projectId, idempotencyKey, contentHash });

    const created = await this.store.runTransaction(async (tx) => {
      const existing = await tx.findRenderJobByFingerprint(fingerprint);
      if (existing) {
        if (existing.uid !== uid) throw new ApiError('FORBIDDEN', 'Рендер недоступен.');
        return { job: existing, isNew: false };
      }
      if ((await tx.countActiveRenderJobs(uid)) >= this.config.render.maxActivePerUser) {
        throw new ApiError('TOO_MANY_ACTIVE_JOBS', 'Уже идёт другой рендер. Дождитесь его завершения.');
      }

      const jobId = newId('job');
      const nowIso = this.now().toISOString();
      const expiresAt = new Date(
        this.now().getTime() + this.config.render.resultTtlDays * 86400_000,
      ).toISOString();

      const job = await tx.putRenderJob({
        id: jobId,
        uid,
        projectId,
        planId: plan.id ?? null,
        fingerprint,
        status: 'queued',
        phase: 'queued',
        progress: 0,
        message: 'Задача создана',
        export: { resolution: exportResolution ?? 'fullHd1080', fps: exportFps ?? 30 },
        attempt: 1,
        createdAt: nowIso,
        updatedAt: nowIso,
        startedAt: null,
        finishedAt: null,
        expiresAt,
        cancelRequested: false,
        result: null,
        error: null,
        workerRef: null,
      });
      return { job, isNew: true };
    });

    if (!created.isNew) return { job: created.job, isNew: false };

    // План кладём в бакет и запускаем ТОЛЬКО worker-v2.
    const paths = renderPaths(uid, projectId, created.job.id);
    await this.signer.writeJson({
      bucket: this.#bucket,
      objectPath: paths.planPath,
      data: { contractVersion: 2, plan, export: created.job.export },
    });

    const launched = await this.#launchWorkerV2(created.job, paths);

    const withRef = await this.store.runTransaction(async (tx) => {
      const job = await tx.getRenderJob(created.job.id);
      if (!job || TERMINAL_STATUSES.has(job.status)) return job;
      return tx.putRenderJob({
        ...job,
        workerRef: launched?.execution ?? null,
        updatedAt: this.now().toISOString(),
      });
    });
    return { job: withRef ?? created.job, isNew: true };
  }

  /** Запуск Cloud Run Job. ЖЁСТКО только v2 (§4B.4, правило 1). */
  async #launchWorkerV2(job, paths) {
    const jobName = this.config.render.workerJobName;
    if (!/(^|-)worker-v2$/.test(jobName)) {
      // Предохранитель: имя Job'а обязано быть v2. EditPlan v2 в worker v1 не
      // уходит ни при какой конфигурации.
      throw new ApiError('RENDER_NOT_CONFIGURED', 'Некорректный worker для v2-рендера.', {
        detail: `refusing to launch non-v2 job «${jobName}»`,
      });
    }
    const env = {
      REELIO_JOB_ID: job.id,
      REELIO_PROJECT_ID: job.projectId,
      REELIO_CONTRACT_VERSION: '2',
      REELIO_BUCKET: this.#bucket,
      REELIO_PLAN_URI: `gs://${this.#bucket}/${paths.planPath}`,
      REELIO_OUTPUT_PREFIX: paths.outputPrefix,
      REELIO_PROJECT_PREFIX: paths.projectPrefix,
      REELIO_JOB_PREFIX: paths.jobPrefix,
      // Прогресс идёт на внутренний endpoint беты, worker аутентифицируется
      // общим токеном (§4B.6). Токен worker берёт из своего секрета, не отсюда.
      REELIO_PROGRESS_URL: `${(this.config.render.publicBaseUrl || '').replace(/\/+$/, '')}/internal/render/progress`,
    };
    return this.jobs.launch({ jobName, region: this.config.render.workerJobRegion, env });
  }

  // ── GET /jobs/:id ─────────────────────────────────────────────────────────
  async getJob(uid, jobId) {
    const job = await this.store.getRenderJob(jobId);
    if (!job || job.uid !== uid) throw new ApiError('JOB_NOT_FOUND', 'Задача рендера не найдена.');
    return job;
  }

  // ── POST /jobs/:id/cancel ─────────────────────────────────────────────────
  async cancelJob(uid, jobId) {
    const job = await this.getJob(uid, jobId);
    if (TERMINAL_STATUSES.has(job.status)) {
      throw new ApiError('JOB_ALREADY_TERMINAL', 'Задача уже завершена.');
    }
    // Останавливаем исполнение Job'а, если оно уже запущено.
    if (job.workerRef && typeof this.jobs.cancel === 'function') {
      try {
        await this.jobs.cancel({ execution: job.workerRef });
      } catch (err) {
        this.logger?.warn?.('cancel execution failed', { jobId, detail: err?.message });
      }
    }
    const nowIso = this.now().toISOString();
    return this.store.runTransaction(async (tx) => {
      const current = await tx.getRenderJob(jobId);
      if (TERMINAL_STATUSES.has(current.status)) return current;
      return tx.putRenderJob({
        ...current,
        status: 'cancelled',
        phase: 'cancelled',
        message: 'Рендер отменён',
        cancelRequested: true,
        updatedAt: nowIso,
        finishedAt: nowIso,
      });
    });
  }

  // ── Внутренний приём прогресса от worker'а (§4B.6) ────────────────────────
  async applyProgress({ jobId, phase, progress, status, message, result, error }) {
    return this.store.runTransaction(async (tx) => {
      const job = await tx.getRenderJob(jobId);
      if (!job) throw new ApiError('JOB_NOT_FOUND', 'Задача рендера не найдена.');
      // Поздний прогресс отменённой/завершённой задачи игнорируем.
      if (TERMINAL_STATUSES.has(job.status)) return job;

      const spec = RENDER_PHASES[phase] ?? RENDER_PHASES.queued;
      const wireStatus = status ?? spec.status;
      const nextProgress = Math.max(job.progress, Math.min(1, Number(progress) || spec.from));
      const nowIso = this.now().toISOString();
      const terminal = TERMINAL_STATUSES.has(wireStatus);

      const paths = renderPaths(job.uid, job.projectId, job.id);
      const finalResult =
        wireStatus === 'succeeded'
          ? {
              objectPath: result?.objectPath ?? paths.outputPath,
              thumbnailObjectPath: result?.thumbnailObjectPath ?? paths.thumbnailPath,
              sizeBytes: Number(result?.sizeBytes) || 0,
              durationSeconds: Number(result?.durationSeconds) || 0,
              width: Number(result?.width) || 1080,
              height: Number(result?.height) || 1920,
              fps: Number(result?.fps) || 30,
              videoCodec: result?.videoCodec ?? 'h264',
              audioCodec: result?.audioCodec ?? 'aac',
              checksumCrc32c: result?.checksumCrc32c ?? null,
              renderedAt: nowIso,
            }
          : job.result;

      return tx.putRenderJob({
        ...job,
        status: wireStatus,
        phase,
        progress: terminal && wireStatus === 'succeeded' ? 1 : nextProgress,
        message: message ?? job.message,
        startedAt: job.startedAt ?? (wireStatus === 'running' ? nowIso : job.startedAt),
        updatedAt: nowIso,
        finishedAt: terminal ? nowIso : job.finishedAt,
        result: finalResult,
        error:
          wireStatus === 'failed'
            ? { code: error?.code ?? 'RENDER_FAILED', message: error?.message ?? 'Рендер не удался.', retryable: error?.retryable ?? true }
            : job.error,
      });
    });
  }

  // ── GET /download ─────────────────────────────────────────────────────────
  async getDownload(uid, jobId) {
    this.#assertConfigured();
    const job = await this.getJob(uid, jobId);
    if (job.status !== 'succeeded' || !job.result) {
      throw new ApiError('JOB_NOT_FOUND', 'Готового результата ещё нет.', { detail: `status=${job.status}` });
    }
    if (job.expiresAt && new Date(job.expiresAt).getTime() <= this.now().getTime()) {
      throw new ApiError('RESULT_EXPIRED', 'Срок хранения результата истёк.');
    }
    const fileName = `reelio_${job.result.height}p.mp4`;
    const signed = await this.signer.downloadUrl({
      bucket: this.#bucket,
      objectPath: job.result.objectPath,
      ttlSeconds: this.config.storage.signedUrlTtlSeconds,
      fileName,
    });
    return {
      downloadUrl: signed.url,
      fileName,
      expiresAt: signed.expiresAt,
      sizeBytes: job.result.sizeBytes,
    };
  }
}

/**
 * Боевые адаптеры: подпись URL (GCS) и запуск Job (Cloud Run Jobs API). SDK
 * грузятся динамически. Локально/в тестах адаптеры подставляются фейками.
 */
export async function createRenderAdapters(config) {
  if (config.mode !== 'cloud' || !config.storage.bucket) return { signer: null, jobs: null };

  const { Storage } = await import('@google-cloud/storage');
  const storage = new Storage({ projectId: config.firebase.projectId });

  const signer = {
    async uploadUrl({ bucket, objectPath, contentType, ttlSeconds }) {
      const [url] = await storage
        .bucket(bucket)
        .file(objectPath)
        .getSignedUrl({ version: 'v4', action: 'write', contentType, expires: Date.now() + ttlSeconds * 1000 });
      return {
        url,
        headers: { 'Content-Type': contentType },
        expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      };
    },
    async downloadUrl({ bucket, objectPath, ttlSeconds, fileName }) {
      const [url] = await storage
        .bucket(bucket)
        .file(objectPath)
        .getSignedUrl({
          version: 'v4',
          action: 'read',
          expires: Date.now() + ttlSeconds * 1000,
          responseDisposition: `attachment; filename="${fileName}"`,
        });
      return { url, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() };
    },
    async writeJson({ bucket, objectPath, data }) {
      await storage
        .bucket(bucket)
        .file(objectPath)
        .save(JSON.stringify(data), { contentType: 'application/json', resumable: false });
    },
  };

  const { JobsClient } = await import('@google-cloud/run');
  const runClient = new JobsClient();
  const jobs = {
    async launch({ jobName, region, env }) {
      const name = runClient.jobPath(config.firebase.projectId, region, jobName);
      const overrides = {
        containerOverrides: [
          { env: Object.entries(env).map(([k, v]) => ({ name: k, value: String(v) })) },
        ],
      };
      const [operation] = await runClient.runJob({ name, overrides });
      return { execution: operation?.name ?? name };
    },
    async cancel({ execution }) {
      // Отмена исполнения Cloud Run Job.
      const { ExecutionsClient } = await import('@google-cloud/run');
      const exec = new ExecutionsClient();
      await exec.cancelExecution({ name: execution });
    },
  };

  return { signer, jobs };
}
