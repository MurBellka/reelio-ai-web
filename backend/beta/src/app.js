// Сборка Express-приложения beta backend'а.
//
// Вынесено из server.js, чтобы тесты поднимали приложение без прослушивания
// порта, без Firebase и без облачных ресурсов.

import { randomBytes } from 'node:crypto';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';

import { AnalysisService } from './analysis-service.js';
import { appCheckGuard, createVerifier, requireAuth } from './auth.js';
import { healthSnapshot, loadConfig } from './config.js';
import { ApiError, errorHandler } from './errors.js';
import { createGeminiClient } from './gemini.js';
import { createAnalysisRoutes } from './routes.js';
import { MemoryStore, buildQuotaOps } from './store.js';

/** Ответ на превышение частоты — в том же конверте, что остальные ошибки. */
function rateLimitHandler(req, res) {
  const err = new ApiError('RATE_LIMITED', 'Слишком много запросов, попробуйте позже.');
  res.status(err.status).json(err.toBody(req.requestId));
}

export async function createApp(overrides = {}) {
  const config = overrides.config ?? loadConfig();
  const store = overrides.store ?? new MemoryStore();
  const quota = buildQuotaOps({ limits: config.limits, store });

  const verifier = overrides.verifier ?? (await createVerifier(config));
  const gemini =
    overrides.gemini ?? (config.gemini.configured ? createGeminiClient(process.env) : null);

  const service =
    overrides.service ??
    new AnalysisService({
      store,
      quota,
      limits: config.limits,
      gemini,
      media: overrides.media,
      logger: overrides.logger,
    });

  const routes = createAnalysisRoutes({ service, quota, limits: config.limits });

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

  app.use((req, _res, next) => next(new ApiError('ANALYSIS_NOT_FOUND', 'Маршрут не найден.')));
  app.use(errorHandler);

  return { app, config, store, service, quota };
}
