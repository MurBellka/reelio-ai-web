// HTTP-слой контракта рендера: /render, /jobs/{id}, /jobs/{id}/cancel,
// /download и внутренний канал прогресса worker'а (§8, §8.1).

import { createHash, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';

import { ApiError } from './errors.js';
import { toPublicJob } from './jobs.js';
import { LocalStorage } from './storage.js';

/** Express 4 не ловит отказы async-обработчиков — оборачиваем явно. */
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const JOB_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function jobIdOf(req) {
  const id = req.params.id;
  if (!JOB_ID_RE.test(id)) {
    throw new ApiError('JOB_NOT_FOUND', 'Некорректный идентификатор задачи.');
  }
  return id;
}

/** Постоянное по времени сравнение токена worker'а. */
function tokenMatches(provided, expected) {
  const a = createHash('sha256').update(provided || '').digest();
  const b = createHash('sha256').update(expected || '').digest();
  return timingSafeEqual(a, b);
}

export function createRenderRoutes({ service, config, storage }) {
  const router = Router();

  const renderLimiter = rateLimit({
    windowMs: 60_000,
    max: config.rateLimits.render,
    standardHeaders: true,
  });
  const pollLimiter = rateLimit({
    windowMs: 60_000,
    max: config.rateLimits.poll,
    standardHeaders: true,
  });

  // ── POST /render ────────────────────────────────────────────────────────
  router.post(
    '/render',
    renderLimiter,
    wrap(async (req, res) => {
      const header = req.get('Idempotency-Key');
      if (header && header.length > 200) {
        throw new ApiError('INVALID_REQUEST', 'Слишком длинный Idempotency-Key.');
      }
      const bodyKey = typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey : '';
      if (bodyKey.length > 200) {
        throw new ApiError('INVALID_REQUEST', 'Слишком длинный idempotencyKey.', {
          field: 'idempotencyKey',
        });
      }

      const { job, created } = await service.createJob(req.body, {
        idempotencyKey: header || bodyKey || '',
      });
      res.status(created ? 202 : 200).json(toPublicJob(job));
    }),
  );

  // ── GET /jobs/{id} ──────────────────────────────────────────────────────
  router.get(
    '/jobs/:id',
    pollLimiter,
    wrap(async (req, res) => {
      const job = await service.getJob(jobIdOf(req));
      const body = toPublicJob(job);

      // Дешёвый поллинг: ETag меняется только при реальном изменении задачи.
      const etag = `W/"${job.status}-${job.phase}-${job.progress}-${job.updatedAt}"`;
      res.set('Cache-Control', 'no-store');
      res.set('ETag', etag);
      if (req.get('If-None-Match') === etag) return res.status(304).end();
      return res.json(body);
    }),
  );

  // ── POST /jobs/{id}/cancel ──────────────────────────────────────────────
  router.post(
    '/jobs/:id/cancel',
    renderLimiter,
    wrap(async (req, res) => {
      const job = await service.cancelJob(jobIdOf(req));
      res.json(toPublicJob(job));
    }),
  );

  // ── GET /download?jobId=… ───────────────────────────────────────────────
  router.get(
    '/download',
    pollLimiter,
    wrap(async (req, res) => {
      const jobId = String(req.query.jobId || '');
      if (!JOB_ID_RE.test(jobId)) {
        throw new ApiError('INVALID_REQUEST', 'Не указан корректный jobId.', { field: 'jobId' });
      }
      const info = await service.downloadInfo(jobId);
      res.set('Cache-Control', 'no-store');
      if (String(req.query.redirect) === '1') return res.redirect(302, info.downloadUrl);
      return res.json(info);
    }),
  );

  // ── Локальный аналог signed URL (§10). В облаке файл отдаёт сам GCS. ─────
  if (storage instanceof LocalStorage) {
    router.get(
      '/download/file',
      wrap(async (req, res) => {
        const object = String(req.query.object || '');
        const expires = String(req.query.expires || '');
        const sig = String(req.query.sig || '');
        if (!storage.verify(object, expires, sig)) {
          throw new ApiError('FORBIDDEN', 'Ссылка недействительна или истекла.');
        }
        const fileName = String(req.query.filename || 'reel.mp4').replace(/[^\w.-]/g, '');
        res.set('Cache-Control', 'no-store');
        res.download(storage.localFilePath(object), fileName);
      }),
    );
  }

  // ── POST /internal/jobs/{id}/progress — только worker (§8.1) ────────────
  router.post(
    '/internal/jobs/:id/progress',
    wrap(async (req, res) => {
      const auth = req.get('Authorization') || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!token || !tokenMatches(token, config.render.workerToken)) {
        throw new ApiError('UNAUTHENTICATED', 'Требуется токен обработчика рендера.');
      }
      res.set('Cache-Control', 'no-store');
      res.json(await service.applyProgress(jobIdOf(req), req.body || {}));
    }),
  );

  return router;
}
