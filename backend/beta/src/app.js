// Сборка Express-приложения beta backend'а.
//
// Вынесено из server.js, чтобы тесты поднимали приложение без прослушивания
// порта, без Firebase и без облачных ресурсов.

import { randomBytes } from 'node:crypto';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';

import { AnalysisService } from './analysis-service.js';
import {
  appCheckGuard,
  createOidcVerifier,
  createVerifier,
  internalGuard,
  requireAuth,
  workerTokenGuard,
} from './auth.js';
import { healthSnapshot, loadConfig } from './config.js';
import { ApiError, errorHandler } from './errors.js';
import { createGeminiClient } from './gemini.js';
import { RenderService, createRenderAdapters } from './render.js';
import { createRenderRoutes, renderProgressHandler } from './render-routes.js';
import { createAnalysisRoutes } from './routes.js';
import { assertStoreForMode, buildQuotaOps, createStore } from './store.js';
import { createTaskQueue } from './tasks.js';

/** Ответ на превышение частоты — в том же конверте, что остальные ошибки. */
function rateLimitHandler(req, res) {
  const err = new ApiError('RATE_LIMITED', 'Слишком много запросов, попробуйте позже.');
  res.status(err.status).json(err.toBody(req.requestId));
}

export async function createApp(overrides = {}) {
  const config = overrides.config ?? loadConfig();
  // §4A.5: в cloud mode фабрика вернёт Firestore и откажется от MemoryStore.
  const store = overrides.store ?? (await createStore(config));
  assertStoreForMode(config, store);
  const quota = buildQuotaOps({ limits: config.limits, store });

  const verifier = overrides.verifier ?? (await createVerifier(config));
  const gemini =
    overrides.gemini ?? (config.gemini.configured ? createGeminiClient(process.env) : null);

  // Долговечная очередь (§4A.7). Обработчик — runJob сервиса; для CloudTasks
  // обработчик не нужен (его дёргает внутренний endpoint).
  const taskQueue = overrides.taskQueue ?? createTaskQueue(config, null);

  const service =
    overrides.service ??
    new AnalysisService({
      store,
      quota,
      limits: config.limits,
      gemini,
      media: overrides.media,
      logger: overrides.logger,
      taskQueue,
    });

  if (taskQueue && typeof taskQueue.setHandler === 'function') {
    taskQueue.setHandler((payload) => service.runJob(payload.jobId, payload));
  }

  const oidcVerifier = overrides.oidcVerifier ?? (await createOidcVerifier(config));

  // Render API v2 (§4B). Адаптеры подписи URL и запуска Job — фейки в тестах,
  // боевые (GCS + Cloud Run Jobs) в облаке.
  const renderAdapters = overrides.render ?? (await createRenderAdapters(config));
  const renderService =
    overrides.renderService ??
    new RenderService({
      store,
      config,
      signer: renderAdapters.signer,
      jobs: renderAdapters.jobs,
      logger: overrides.logger,
      now: overrides.now,
    });

  const routes = createAnalysisRoutes({ service, quota, limits: config.limits });
  const render = createRenderRoutes({ renderService });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Cloud Run терминирует TLS перед приложением.
  app.use(express.json({ limit: '1mb' }));

  // Идентификатор запроса — для корреляции логов и поля error.requestId.
  app.use((req, _res, next) => {
    req.requestId = `req_${randomBytes(8).toString('hex')}`;
    req.log = overrides.logger ?? null;
    next();
  });

  app.use(
    cors({
      origin(origin, cb) {
        if (!origin || config.cors.allowedOrigins.has(origin)) return cb(null, true);
        return cb(new Error('Origin not allowed'));
      },
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Firebase-AppCheck', 'Idempotency-Key'],
    }),
  );

  // /health не требует ни авторизации, ни App Check: его дёргает Cloud Run.
  app.get('/health', (_req, res) => res.json(healthSnapshot(config)));

  // Внутренний endpoint (§4A.7): его дёргает ТОЛЬКО Cloud Tasks с OIDC-токеном.
  // Не пользовательский маршрут: без валидного OIDC он закрыт. На retryable-сбой
  // отвечает 500, чтобы Cloud Tasks повторил задачу; на успехе/терминале — 200.
  app.post(
    '/internal/analysis/run',
    internalGuard({ verifier: oidcVerifier, audience: config.tasks.internalUrl }),
    (req, res, next) => {
      const payload = req.body ?? {};
      const attempt = Number.parseInt(req.get?.('x-cloudtasks-taskretrycount') ?? '', 10);
      service
        .runJob(payload.jobId, {
          ...payload,
          attempt: Number.isFinite(attempt) ? attempt : payload.attempt ?? 0,
          maxAttempts: payload.maxAttempts ?? 3,
        })
        .then(() => res.json({ ok: true }))
        // Проброс = сигнал очереди повторить (retryable, не последняя попытка).
        .catch((err) => next(new ApiError('ANALYSIS_FAILED', 'Задача будет повторена.', {
          detail: err?.message,
        })));
    },
  );

  // App Check и аутентификация — два независимых middleware. Порядок важен
  // только для читаемости логов: провал App Check не должен зависеть от того,
  // валиден ли токен пользователя, и наоборот.
  const guards = [
    appCheckGuard({ verifier, mode: config.auth.appCheckMode }),
    requireAuth({ verifier, config: config.auth }),
  ];

  const createLimiter = rateLimit({
    windowMs: 60_000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitHandler,
    keyGenerator: (req) => req.uid ?? req.ip,
  });
  const readLimiter = rateLimit({
    windowMs: 60_000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitHandler,
    keyGenerator: (req) => req.uid ?? req.ip,
  });

  app.post('/analysis', ...guards, createLimiter, routes.create);
  app.get('/analysis/:id', ...guards, readLimiter, routes.status);
  app.post('/analysis/:id/cancel', ...guards, readLimiter, routes.cancel);
  app.post('/analysis/:id/retry', ...guards, createLimiter, routes.retry);
  app.post('/analysis/:id/plan', ...guards, readLimiter, routes.plan);
  app.get('/analysis/:id/plan', ...guards, readLimiter, routes.plan);
  app.get('/catalog', ...guards, readLimiter, routes.catalog);
  app.get('/usage', ...guards, readLimiter, routes.usage);

  // Render API v2 (§4B) — те же guard'ы и лимитеры.
  app.post('/uploads', ...guards, createLimiter, render.uploads);
  app.post('/render', ...guards, createLimiter, render.render);
  app.get('/jobs/:id', ...guards, readLimiter, render.job);
  app.post('/jobs/:id/cancel', ...guards, readLimiter, render.cancel);
  app.get('/download', ...guards, readLimiter, render.download);

  // Канал прогресса worker'а: только по токену worker'а (§4B.6), без App
  // Check и без Firebase Auth (это не пользовательский запрос).
  app.post(
    '/internal/render/jobs/:jobId/progress',
    workerTokenGuard({ token: config.render.workerToken }),
    renderProgressHandler({ renderService }),
  );

  app.use((req, _res, next) => next(new ApiError('ANALYSIS_NOT_FOUND', 'Маршрут не найден.')));
  app.use(errorHandler);

  return { app, config, store, service, quota, taskQueue, renderService };
}
