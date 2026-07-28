// Точка входа beta backend'а (§4A.1).
//
// Поднимает HTTP-сервер и корректно завершается по SIGTERM/SIGINT: Cloud Run
// шлёт SIGTERM при масштабировании вниз и отмене, и приложение обязано
// дождаться уже принятых запросов, а не рвать их на середине.
//
// Модуль import-safe: сам сервер стартует только при прямом запуске
// (`node src/index.js`), поэтому тесты могут импортировать `startServer`
// без побочных эффектов.

import { createApp } from './app.js';
import { loadConfig } from './config.js';

/** Собирает приложение и начинает слушать порт. Возвращает управление сервером. */
export async function startServer(env = process.env) {
  const config = loadConfig(env);
  const built = await createApp({ config });
  const { app } = built;

  const server = await new Promise((resolve) => {
    const s = app.listen(config.port, () => resolve(s));
  });

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({ msg: 'listening', service: config.service, mode: config.mode, port: config.port }),
  );

  let shuttingDown = false;
  const drain = async () => {
    // Дождаться фоновых задач встроенной очереди (в облаке их держит Cloud
    // Tasks, а не процесс, поэтому drain там — no-op).
    try {
      if (typeof built.taskQueue?.drain === 'function') await built.taskQueue.drain();
      await (built.service?._pending ?? Promise.resolve());
    } catch {
      // Ошибка фоновой задачи уже записана в задачу — глотаем, чтобы не
      // помешать чистому завершению.
    }
  };

  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ msg: 'shutdown', signal }));
    server.close(async () => {
      await drain();
      process.exit(0);
    });
    // Жёсткий предел: не зависать дольше, чем длится grace-период Cloud Run.
    setTimeout(() => process.exit(1), 25_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return { server, config, ...built, shutdown, drain };
}

// Автозапуск только при прямом вызове модуля.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  startServer().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ msg: 'startup failed', error: String(err?.message || err) }));
    process.exit(1);
  });
}
