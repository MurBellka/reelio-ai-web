// Маршруты beta API (§1 долга).
//
//   POST /analysis              создать анализ (идемпотентно)
//   GET  /analysis/{id}         статус и прогресс
//   POST /analysis/{id}/cancel  отмена
//   POST /analysis/{id}/retry   безопасный повтор после ошибки
//   GET  /analysis/{id}/plan    готовый EditPlan v2
//   GET  /catalog               каталоги переходов, шрифтов и лимитов для UI
//   GET  /usage                 текущее потребление квоты
//
// Все маршруты требуют аутентификации; App Check проверяется отдельным
// middleware и не подменяет её. Владение проверяется на каждом обращении к
// задаче — идентификатор в URL сам по себе ничего не даёт.

import { assertOwnedPath, projectPrefixFor } from './auth.js';
import { buildPromptCatalog } from './catalog.js';
import { assemblePlan } from './editplan.js';
import { ApiError } from './errors.js';
import { ANALYSIS_QUOTA, ANALYSIS_LIMITS, COST_LIMITS, PROJECT_LIMITS } from './limits.js';
import { normalizeOperations } from './operations.js';
import { toPublicJob } from './analysis-service.js';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function requireId(value, field) {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    throw new ApiError('INVALID_REQUEST', `Некорректный идентификатор «${field}».`, { field });
  }
  return value;
}

/**
 * Разбирает и проверяет материалы запроса.
 *
 * Здесь же выполняется изоляция по uid (§3): путь каждого материала обязан
 * лежать внутри префикса ЭТОГО пользователя. Префикс строит сервер, клиент
 * его не присылает.
 */
function parseAssets(raw, uid, projectId) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ApiError('INVALID_REQUEST', 'Не переданы материалы для анализа.', { field: 'assets' });
  }

  const seen = new Set();
  return raw.map((asset, i) => {
    const field = `assets[${i}]`;
    if (!asset || typeof asset !== 'object') {
      throw new ApiError('INVALID_REQUEST', 'Материал должен быть объектом.', { field });
    }

    const id = requireId(asset.id, `${field}.id`);
    if (seen.has(id)) {
      throw new ApiError('INVALID_REQUEST', `Дублирующийся материал «${id}».`, { field });
    }
    seen.add(id);

    if (asset.type !== 'video' && asset.type !== 'photo') {
      throw new ApiError('INVALID_REQUEST', 'Тип материала должен быть video или photo.', { field });
    }

    return {
      id,
      type: asset.type,
      objectPath: assertOwnedPath(asset.objectPath, uid, projectId, `${field}.objectPath`),
      durationSeconds: Number.isFinite(asset.durationSeconds) ? Number(asset.durationSeconds) : null,
      // Хеш содержимого, если клиент его знает: ускоряет попадание в кэш.
      // Доверять ему нельзя — сервер всё равно пересчитает при измерении.
      contentHash: typeof asset.contentHash === 'string' ? asset.contentHash.slice(0, 128) : null,
      language: typeof asset.language === 'string' ? asset.language.slice(0, 16) : null,
    };
  });
}

/** Обёртка async-обработчика: ошибки уходят в errorHandler, а не в unhandled. */
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

export function createAnalysisRoutes({ service, quota, limits }) {
  return {
    /** POST /analysis */
    create: wrap(async (req, res) => {
      const body = req.body ?? {};
      const projectId = requireId(body.projectId, 'projectId');
      const assets = parseAssets(body.assets, req.uid, projectId);

      // Ключ идемпотентности — из заголовка либо из тела (§4).
      const headerKey = req.get?.('idempotency-key');
      const idempotencyKey = (headerKey || body.idempotencyKey || '').slice(0, 200) || null;

      const { job, isNew } = await service.createAnalysis({
        uid: req.uid,
        projectId,
        assets,
        idempotencyKey,
      });

      // 202 — приняли новую работу, 200 — вернули уже существующую.
      res.status(isNew ? 202 : 200).json({ analysis: toPublicJob(job) });
    }),

    /** GET /analysis/:id */
    status: wrap(async (req, res) => {
      const job = await service.getAnalysis(req.uid, requireId(req.params.id, 'id'));
      res.set('Cache-Control', 'no-store');
      res.json({ analysis: toPublicJob(job) });
    }),

    /** POST /analysis/:id/cancel */
    cancel: wrap(async (req, res) => {
      const job = await service.cancelAnalysis(req.uid, requireId(req.params.id, 'id'));
      res.json({ analysis: toPublicJob(job) });
    }),

    /** POST /analysis/:id/retry */
    retry: wrap(async (req, res) => {
      const id = requireId(req.params.id, 'id');
      const existing = await service.getAnalysis(req.uid, id);
      const assets = parseAssets(req.body?.assets, req.uid, existing.projectId);

      const { job, isNew } = await service.retryAnalysis(req.uid, id, assets);
      res.status(isNew ? 202 : 200).json({ analysis: toPublicJob(job) });
    }),

    /**
     * GET /analysis/:id/plan — собрать EditPlan v2 из готового анализа.
     *
     * Сборка плана бесплатна и повторяема: она использует уже полученный
     * анализ и не обращается к модели. Поэтому пользователь может сколько
     * угодно менять команды и смотреть предпросмотр до платного рендера.
     */
    plan: wrap(async (req, res) => {
      const job = await service.getAnalysis(req.uid, requireId(req.params.id, 'id'));
      if (job.status !== 'succeeded') {
        throw new ApiError('ANALYSIS_NOT_FOUND', 'Анализ ещё не готов.', {
          detail: `status=${job.status}`,
        });
      }

      const draftIds = new Set();
      const { operations, warnings: opWarnings } = normalizeOperations(
        { operations: req.body?.operations ?? req.query?.operations ?? [] },
        { clipIds: draftIds, textIds: new Set(), maxDuration: PROJECT_LIMITS.maxOutputDurationSeconds },
      );

      const { plan, warnings } = assemblePlan({
        planId: `plan_${job.id}`,
        prompt: typeof req.body?.prompt === 'string' ? req.body.prompt : '',
        analyses: job.analyses,
        operations,
        targetDurationSeconds: Number(req.body?.targetDurationSeconds) || undefined,
        verifiedTransitions: req.body?.verifiedTransitions,
      });

      res.json({
        contractVersion: 2,
        plan,
        warnings: [...opWarnings, ...warnings],
        // Клиент строит пути только внутри своего префикса.
        projectPrefix: projectPrefixFor(req.uid, job.projectId),
      });
    }),

    /** GET /catalog — всё, что нужно UI, чтобы не показывать невозможное. */
    catalog: wrap(async (req, res) => {
      res.json({
        contractVersion: 2,
        ...buildPromptCatalog({ verifiedTransitions: req.query?.transitions?.split(',') }),
        limits: {
          maxVideos: PROJECT_LIMITS.maxVideos,
          maxPhotos: PROJECT_LIMITS.maxPhotos,
          maxVideoDurationSeconds: PROJECT_LIMITS.maxVideoDurationSeconds,
          maxOutputDurationSeconds: PROJECT_LIMITS.maxOutputDurationSeconds,
          analysesPerDay: ANALYSIS_QUOTA.perUserPerDay,
          analysesPerProjectPerDay: ANALYSIS_QUOTA.perProjectPerDay,
          maxFramesPerVideo: ANALYSIS_LIMITS.maxFramesPerVideo,
          maxAudioSecondsPerVideo: ANALYSIS_LIMITS.maxAudioSecondsPerVideo,
        },
      });
    }),

    /** GET /usage — сколько анализов осталось сегодня. */
    usage: wrap(async (req, res) => {
      const projectId = req.query?.projectId;
      const usage = await quota.usage(req.uid, projectId && ID_RE.test(projectId) ? projectId : null);

      res.set('Cache-Control', 'no-store');
      res.json({
        day: usage.day,
        analyses: { used: usage.user, limit: usage.userLimit },
        project: projectId ? { used: usage.project, limit: usage.projectLimit } : null,
        // Денежные потолки — забота сервера; наружу отдаём только кредиты.
        creditsPerAnalysis: 1,
        maxCreditsPerDay: limits.perUserPerDay,
      });
    }),
  };
}

export { COST_LIMITS };
