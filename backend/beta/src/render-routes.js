// HTTP-маршруты render API v2 (§4B.1).
//
//   POST /uploads            signed URLs для прямой загрузки материалов
//   POST /render             создать/вернуть задачу рендера (идемпотентно)
//   GET  /jobs/{id}          статус задачи
//   POST /jobs/{id}/cancel   отмена
//   GET  /download           короткоживущая ссылка на результат
//
// Все — за Firebase Auth + App Check. Владение и пути проверяются на сервере.

import { ApiError } from './errors.js';
import { toPublicRenderJob } from './render.js';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function requireId(value, field) {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    throw new ApiError('INVALID_REQUEST', `Некорректный идентификатор «${field}».`, { field });
  }
  return value;
}

const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

export function createRenderRoutes({ renderService }) {
  return {
    /** POST /uploads */
    uploads: wrap(async (req, res) => {
      const body = req.body ?? {};
      const projectId = requireId(body.projectId, 'projectId');
      const { uploads } = await renderService.createUploads({
        uid: req.uid,
        projectId,
        assets: body.assets,
      });
      res.json({ uploads });
    }),

    /** POST /render */
    render: wrap(async (req, res) => {
      const body = req.body ?? {};
      const projectId = requireId(body.projectId, 'projectId');
      const headerKey = req.get?.('idempotency-key');
      const idempotencyKey = (headerKey || body.idempotencyKey || '').slice(0, 200) || null;

      const { job, isNew } = await renderService.submitRender({
        uid: req.uid,
        projectId,
        plan: body.plan,
        assets: body.assets,
        exportResolution: body.export?.resolution,
        exportFps: body.export?.fps,
        idempotencyKey,
      });
      // 202 — приняли новую задачу; 200 — вернули уже существующую (идемпотентно).
      res.status(isNew ? 202 : 200).json(toPublicRenderJob(job));
    }),

    /** GET /jobs/:id */
    job: wrap(async (req, res) => {
      const job = await renderService.getJob(req.uid, requireId(req.params.id, 'id'));
      res.set('Cache-Control', 'no-store');
      res.json(toPublicRenderJob(job));
    }),

    /** POST /jobs/:id/cancel */
    cancel: wrap(async (req, res) => {
      const job = await renderService.cancelJob(req.uid, requireId(req.params.id, 'id'));
      res.json(toPublicRenderJob(job));
    }),

    /** GET /download?jobId=… */
    download: wrap(async (req, res) => {
      const jobId = requireId(req.query?.jobId, 'jobId');
      const dl = await renderService.getDownload(req.uid, jobId);
      res.set('Cache-Control', 'no-store');
      if (req.query?.redirect === '1') {
        return res.redirect(302, dl.downloadUrl);
      }
      res.json(dl);
    }),
  };
}

/**
 * Внутренний приём прогресса worker'а — за workerTokenGuard (§4B.6, §8.1).
 * jobId в ПУТИ; тело — форма worker'а: {phase, fraction, message, result, error}.
 * Ответ несёт cancelRequested, чтобы worker кооперативно остановился.
 */
export function renderProgressHandler({ renderService }) {
  return wrap(async (req, res) => {
    const body = req.body ?? {};
    const jobId = requireId(req.params.jobId, 'jobId');
    const job = await renderService.applyProgress({
      jobId,
      phase: body.phase,
      fraction: body.fraction,
      message: typeof body.message === 'string' ? body.message.slice(0, 300) : undefined,
      result: body.result,
      error: body.error,
    });
    res.json({ ok: true, status: job.status, cancelRequested: Boolean(job.cancelRequested) });
  });
}
