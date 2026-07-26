#!/usr/bin/env node
// Точка входа Cloud Run Job.
//
// Контракт коду выхода:
//   0 — рендер успешен либо корректно отменён (§8.1: отмена — не сбой);
//   1 — рендер не удался; backend уже получил phase: "failed" с кодом §7.
//
// Всё, что нужно для запуска, приходит переменными окружения (§9). Никаких
// аргументов командной строки и никакого доступа к Firestore у worker'а нет.

import { pathToFileURL } from 'node:url';

import { CancelledError, toWorkerError } from './errors.js';
import { loadEnv } from './env.js';
import { Logger } from './logger.js';
import { ProgressReporter } from './progress.js';
import { runRender, uploadWorkerLog } from './render.js';
import { createStorage } from './storage.js';

export async function main(processEnv = process.env) {
  const logger = new Logger({ level: processEnv.REELIO_LOG_LEVEL || 'info' });

  let env;
  try {
    env = loadEnv(processEnv);
  } catch (err) {
    // Отчитаться некуда: канал прогресса настраивается из тех же переменных.
    const wrapped = toWorkerError(err);
    logger.error('worker misconfigured', { code: wrapped.code, detail: wrapped.detail });
    return 1;
  }

  logger.withContext({ jobId: env.jobId, projectId: env.projectId, mode: env.mode });

  const storage = createStorage(env);
  const reporter = new ProgressReporter({
    url: env.progressUrl,
    token: env.workerToken,
    jobId: env.jobId,
    logger,
    heartbeatMs: env.heartbeatMs,
  });

  if (!env.progressUrl) {
    logger.warn('progress channel disabled: REELIO_PROGRESS_URL is empty');
  }

  reporter.start();
  const startedAt = Date.now();

  try {
    const { result } = await runRender({ env, storage, reporter, logger });
    await reporter.reportDone(result, 'Ролик готов');
    logger.info('job succeeded', { elapsedMs: Date.now() - startedAt });
    await uploadWorkerLog({ env, storage, logger });
    return 0;
  } catch (err) {
    reporter.stop();

    if (err instanceof CancelledError) {
      logger.info('job cancelled', { elapsedMs: Date.now() - startedAt });
      // Задача уже терминальна на стороне backend'а — повторный отчёт не нужен.
      if (!reporter.terminated) {
        await reporter.reportCancelled().catch(() => {});
      }
      await uploadWorkerLog({ env, storage, logger });
      return 0;
    }

    const wrapped = toWorkerError(err);
    // detail остаётся в логе, наружу уходит только безопасное сообщение (§7).
    logger.error('job failed', {
      code: wrapped.code,
      field: wrapped.field,
      detail: wrapped.detail,
      elapsedMs: Date.now() - startedAt,
    });
    await reporter.reportFailed(wrapped.toWireError(), wrapped.message).catch(() => {});
    await uploadWorkerLog({ env, storage, logger });
    return 1;
  } finally {
    reporter.stop();
  }
}

// Запуск только как программа, не при импорте из тестов.
// pathToFileURL, а не шаблон `file://…`: путь может содержать пробелы.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.exitCode = 1;
    });
}
