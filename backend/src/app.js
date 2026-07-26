// Сборка Express-приложения. Вынесено из server.js, чтобы тесты поднимали
// приложение без прослушивания порта и без облачных ресурсов.

import { randomBytes } from 'node:crypto';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';

import { createVerifier } from './auth.js';
import { config as defaultConfig, healthSnapshot } from './config.js';
import { appCheckGuard, requireAuth } from './auth.js';
import { requestEditPlan } from './edit-plan.js';
import { ApiError, errorHandler } from './errors.js';
import { RenderJobService } from './jobs.js';
import { createRenderRoutes, rateLimitHandler } from './routes.js';
import { createRunner } from './runner.js';
import { createStorage } from './storage.js';
import { createStore } from './store.js';
import { QuotaStore, buildQuotaOps } from './quota.js';

export async function createApp(config = defaultConfig) {
  const [store, storage, runner, verifier] = await Promise.all([
    createStore(config),
    createStorage(config),
    createRunner(config),
    createVerifier(config),
  ]);

  // Счётчики квот живут в том же хранилище, что и задачи: списание кредита и
  // проверка активных задач обязаны быть в одной транзакции.
  const quota = buildQuotaOps({ limits: config.limits, store: new QuotaStore(store) });
  const service = new RenderJobService({ config, store, storage, runner, quota });

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
    // PUT — только для локального приёмника загрузок (§10). В облаке байты
    // идут прямо в бакет, и CORS там настраивается на самом бакете.
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Firebase-AppCheck',
      'Idempotency-Key',
      'X-Reelio-Client',
      'If-None-Match',
    ],
    exposedHeaders: ['ETag'],
  };
  app.use((req, res, next) => {
    if (req.path.startsWith('/internal/')) return next();
    return cors(corsOptions)(req, res, next);
  });

  app.get('/', (_req, res) => res.json(healthSnapshot(config)));
  app.get('/health', (_req, res) => res.json(healthSnapshot(config)));

  // /edit-plan тоже стоит денег — за авторизацией и под суточной квотой.
  const editPlanGuard = [appCheckGuard({ verifier, config }), requireAuth({ verifier, config })];

  app.post(
    '/edit-plan',
    editPlanGuard,
    rateLimit({
      windowMs: 60_000,
      max: config.rateLimits.editPlan,
      standardHeaders: true,
      handler: rateLimitHandler,
    }),
    (req, res, next) => {
      quota
        .consumeEditPlan(req.auth.uid, req.ip)
        .then(() => requestEditPlan(config, req.body || {}))
        .then((plan) => res.json({ plan }))
        .catch(next);
    },
  );

  app.use(createRenderRoutes({ service, config, storage, verifier, quota }));

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
  app.locals.quota = quota;
  app.locals.verifier = verifier;
  app.locals.storage = storage;
  app.locals.store = store;
  app.locals.runner = runner;
  return app;
}
