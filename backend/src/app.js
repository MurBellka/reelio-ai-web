// Сборка Express-приложения. Вынесено из server.js, чтобы тесты поднимали
// приложение без прослушивания порта и без облачных ресурсов.

import { randomBytes } from 'node:crypto';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';

import { config as defaultConfig, healthSnapshot } from './config.js';
import { requestEditPlan } from './edit-plan.js';
import { ApiError, errorHandler } from './errors.js';
import { RenderJobService } from './jobs.js';
import { createRenderRoutes } from './routes.js';
import { createRunner } from './runner.js';
import { createStorage } from './storage.js';
import { createStore } from './store.js';

export async function createApp(config = defaultConfig) {
  const [store, storage, runner] = await Promise.all([
    createStore(config),
    createStorage(config),
    createRunner(config),
  ]);
  const service = new RenderJobService({ config, store, storage, runner });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Cloud Run терминирует TLS перед приложением.
  app.use(express.json({ limit: '2mb' }));

  // Идентификатор запроса — для корреляции логов и поля error.requestId.
  app.use((req, _res, next) => {
    req.requestId = `req_${randomBytes(8).toString('hex')}`;
    next();
  });

  // CORS: клиентские маршруты — только доверенные источники.
  // Внутренний канал worker'а браузеру недоступен в принципе.
  const corsOptions = {
    origin(origin, cb) {
      if (!origin || config.allowedOrigins.has(origin)) return cb(null, true);
      return cb(new Error('Origin not allowed'));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Idempotency-Key', 'X-Reelio-Client', 'If-None-Match'],
    exposedHeaders: ['ETag'],
  };
  app.use((req, res, next) => {
    if (req.path.startsWith('/internal/')) return next();
    return cors(corsOptions)(req, res, next);
  });

  app.get('/', (_req, res) => res.json(healthSnapshot(config)));
  app.get('/health', (_req, res) => res.json(healthSnapshot(config)));

  app.post(
    '/edit-plan',
    rateLimit({ windowMs: 60_000, max: config.rateLimits.editPlan, standardHeaders: true }),
    (req, res, next) => {
      requestEditPlan(config, req.body || {})
        .then((plan) => res.json({ plan }))
        .catch(next);
    },
  );

  app.use(createRenderRoutes({ service, config, storage }));

  // Неизвестный маршрут. Отдельного кода в контракте v1 нет, а JOB_NOT_FOUND
  // здесь вводил бы клиента в заблуждение — используем INVALID_REQUEST с 404.
  // TODO: добавить ROUTE_NOT_FOUND в §7 при следующей ревизии контракта
  // (только вместе с остановкой параллельной работы worker'а и UI).
  app.use((req, _res, next) => {
    next(
      new ApiError('INVALID_REQUEST', `Маршрут ${req.method} ${req.path} не найден.`, {
        status: 404,
      }),
    );
  });
  app.use(errorHandler);

  app.locals.service = service;
  app.locals.storage = storage;
  app.locals.store = store;
  app.locals.runner = runner;
  return app;
}
