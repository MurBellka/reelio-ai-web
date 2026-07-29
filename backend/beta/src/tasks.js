// Долговечное выполнение задач (§4A.6, §4A.7).
//
// Прежде анализ запускался fire-and-forget (`#run(...).catch()`). На Cloud Run
// это ненадёжно: инстанс может быть остановлен сразу после HTTP-ответа, и
// работа теряется. Теперь задача ставится в очередь.
//
// Две реализации за одним интерфейсом `enqueue(payload)`:
//   • InlineTaskQueue — локально и в тестах: запускает обработчик асинхронно,
//     с повторами и возможностью дождаться завершения (`drain`);
//   • CloudTasksQueue — в облаке: создаёт HTTP-задачу Cloud Tasks с OIDC, и
//     обработчик выполняется отдельным вызовом внутреннего endpoint'а. Очередь
//     переживает перезапуск инстанса — это и есть замена fire-and-forget,
//     а НЕ `min-instances=1` (§4A.8).

import { INTERNAL_TASK_PATH } from './config.js';

/**
 * Встроенная очередь. `handler(payload)` получает {..., attempt, maxAttempts}.
 * Повтор — только если handler бросил исключение (retryable-сбой); на последней
 * попытке handler обязан сам зафиксировать терминальное состояние и не бросать.
 */
export class InlineTaskQueue {
  constructor({ handler, maxAttempts = 3 } = {}) {
    this.handler = handler;
    this.maxAttempts = maxAttempts;
    this.pending = new Set();
  }

  setHandler(handler) {
    this.handler = handler;
  }

  enqueue(payload) {
    const promise = this.#process(payload).catch(() => {});
    this.pending.add(promise);
    promise.finally(() => this.pending.delete(promise));
    return Promise.resolve({ scheduled: true });
  }

  async #process(payload) {
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      try {
        await this.handler({ ...payload, attempt, maxAttempts: this.maxAttempts });
        return;
      } catch (err) {
        // Последняя попытка: handler уже должен был записать терминальный
        // статус; исключение здесь — страховка, глотаем.
        if (attempt >= this.maxAttempts - 1) return;
        // Иначе — повтор (следующая итерация цикла).
      }
    }
  }

  /** Дождаться всех фоновых задач — для graceful shutdown и детерминизма тестов. */
  async drain() {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }
}

/**
 * Очередь Cloud Tasks. SDK грузится динамически, чтобы юнит-тесты не тянули
 * @google-cloud/tasks. Обработчик выполняется НЕ здесь, а отдельным HTTP-вызовом
 * внутреннего endpoint'а, который Cloud Tasks дёргает с OIDC-токеном.
 */
export class CloudTasksQueue {
  /**
   * @param {{queue:string, location:string, projectId:string, internalUrl:string,
   *          oidcAudience:string, invokerServiceAccount:string, internalPath?:string,
   *          client?:object}} cfg
   */
  constructor(cfg) {
    this.cfg = cfg;
    // Инъекция клиента в тестах: реальный Cloud Tasks SDK не тянется.
    this.client = cfg.client ?? null;
  }

  async #ensureClient() {
    if (!this.client) {
      const { CloudTasksClient } = await import('@google-cloud/tasks');
      this.client = new CloudTasksClient();
    }
    return this.client;
  }

  async enqueue(payload) {
    const { queue, location, projectId, internalUrl, oidcAudience, invokerServiceAccount } =
      this.cfg;
    if (!queue || !internalUrl || !oidcAudience || !invokerServiceAccount) {
      throw new Error('CloudTasksQueue не сконфигурирована (queue/internalUrl/audience/SA).');
    }
    const client = await this.#ensureClient();
    const parent = client.queuePath(projectId, location, queue);

    // Одна каноническая настройка (§4A.7):
    //   • target URL = стабильный origin + ФИКСИРОВАННЫЙ внутренний путь;
    //   • OIDC audience = тот же origin БЕЗ пути (config.tasks.oidcAudience).
    // Именно расхождение «audience с путём» ↔ «guard без пути» давало FORBIDDEN
    // на каждую задачу; теперь audience берётся из канонического значения, а не
    // из target URL.
    const internalPath = this.cfg.internalPath ?? INTERNAL_TASK_PATH;
    const url = `${internalUrl.replace(/\/+$/, '')}${internalPath}`;

    const task = {
      httpRequest: {
        httpMethod: 'POST',
        url,
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify(payload)).toString('base64'),
        // OIDC-токен: Cloud Tasks подписывает его от имени invoker SA, а
        // внутренний endpoint его проверяет (§4A.7). Audience — канонический
        // origin, БЕЗ пути.
        oidcToken: { serviceAccountEmail: invokerServiceAccount, audience: oidcAudience },
      },
      // Дедупликация: одинаковый payload той же задачи не создаёт дубль.
      ...(payload.jobId ? { name: `${parent}/tasks/${payload.kind}-${payload.jobId}` } : {}),
    };

    const [created] = await client.createTask({ parent, task });
    return { scheduled: true, name: created.name };
  }
}

/** Фабрика очереди: Cloud Tasks в облаке, встроенная — локально/в тестах. */
export function createTaskQueue(config, handler) {
  if (config.mode === 'cloud' && config.tasks.queue) {
    return new CloudTasksQueue({
      queue: config.tasks.queue,
      location: config.tasks.location,
      projectId: config.firebase.projectId,
      internalUrl: config.tasks.internalUrl,
      internalPath: config.tasks.internalPath,
      oidcAudience: config.tasks.oidcAudience,
      invokerServiceAccount: config.tasks.invokerServiceAccount,
    });
  }
  return new InlineTaskQueue({ handler });
}
