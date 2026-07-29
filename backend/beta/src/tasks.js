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

import { createHash } from 'node:crypto';

import { INTERNAL_TASK_PATH } from './config.js';

// ── Идентификатор задачи Cloud Tasks ────────────────────────────────────────
//
// Cloud Tasks разрешает в ID задачи ТОЛЬКО символы `[A-Za-z0-9_-]`, длиной до
// 500. Точка (как в kind `analysis.run`) → INVALID_ARGUMENT, и задача НИКОГДА
// не ставится (durable-анализ навсегда застревает в `queued`). Поэтому ID не
// собирается «как есть» из пользовательского значения, а строится по правилам:
//
//   • kind отображается в безопасный префикс из ЗАКРЫТОГО списка; неизвестный
//     kind отклоняется ДО обращения к API;
//   • jobId (серверный) проверяется по допустимому алфавиту и длине; если он
//     выходит за рамки — берётся стабильный SHA-256 дайджест (base64url),
//     детерминированный и состоящий только из разрешённых символов;
//   • ID = `<префикс kind>-<сегмент jobId>`: разные kind дают разные префиксы,
//     разные jobId — разные сегменты, поэтому коллизий между задачами нет;
//   • ID детерминирован по (kind, jobId) — это и есть ключ дедупликации/
//     идемпотентности Cloud Tasks (повторный enqueue → ALREADY_EXISTS).

/** Максимальная длина ID задачи Cloud Tasks. */
export const TASK_ID_MAX_LENGTH = 500;

const TASK_ID_ALLOWED = /^[A-Za-z0-9_-]+$/;

/** Закрытое отображение известных типов задач → безопасный префикс ID. */
export const TASK_KIND_PREFIXES = Object.freeze({
  'analysis.run': 'analysis-run',
});

/** Неизвестный kind — дефект вызова, не пользовательская ошибка. */
export class UnknownTaskKindError extends Error {
  constructor(kind) {
    super(`Неизвестный тип задачи Cloud Tasks: «${kind}».`);
    this.name = 'UnknownTaskKindError';
    this.code = 'INTERNAL';
  }
}

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Безопасный сегмент из jobId. Обычный серверный jobId (короткий, только
 * `[A-Za-z0-9_-]`) используется как есть — ID остаётся читаемым. Всё остальное
 * (пусто, запрещённые символы, слишком длинное) заменяется стабильным
 * дайджестом. Префикс `d_` отделяет дайджест от прямых значений, так что прямой
 * jobId никогда не совпадёт с дайджестом другого jobId.
 */
function safeJobSegment(jobId, maxLength) {
  const id = String(jobId ?? '');
  if (id && TASK_ID_ALLOWED.test(id) && id.length <= maxLength) return id;
  return `d_${base64url(createHash('sha256').update(id).digest())}`;
}

/**
 * ID задачи Cloud Tasks для пары (kind, jobId). Детерминирован, содержит только
 * разрешённые символы и укладывается в лимит длины. Неизвестный kind отклоняется
 * ДО обращения к API.
 *
 * @param {string} kind тип задачи из TASK_KIND_PREFIXES
 * @param {string} jobId серверный идентификатор задачи
 * @returns {string} безопасный ID задачи
 */
export function buildTaskId(kind, jobId) {
  const prefix = TASK_KIND_PREFIXES[kind];
  if (!prefix) throw new UnknownTaskKindError(kind);
  // Бюджет под сегмент: вычитаем префикс и разделитель. Дайджест (~45 символов)
  // заведомо влезает, поэтому длинный jobId безопасно сворачивается.
  const budget = TASK_ID_MAX_LENGTH - prefix.length - 1;
  const id = `${prefix}-${safeJobSegment(jobId, budget)}`;
  // Инвариант: результат обязан быть валиден. Нарушение — дефект этого кода.
  if (!TASK_ID_ALLOWED.test(id) || id.length > TASK_ID_MAX_LENGTH) {
    throw new Error(`Построен недопустимый Cloud Tasks ID: «${id}».`);
  }
  return id;
}

/**
 * ALREADY_EXISTS от Cloud Tasks (gRPC-код 6): для детерминированного ID это НЕ
 * ошибка, а признак идемпотентности — задача уже поставлена. Проверяем и
 * числовой код, и строковую форму, и текст (разные версии SDK различаются).
 */
export function isAlreadyExistsError(err) {
  return (
    err?.code === 6 ||
    err?.code === 'ALREADY_EXISTS' ||
    /already[\s_-]?exists/i.test(String(err?.message ?? err ?? ''))
  );
}

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

    // ID задачи строится и валидируется ДО обращения к API: неизвестный kind
    // или недопустимый jobId не должны доходить до Cloud Tasks (§4A.6).
    const taskId = payload.jobId != null ? buildTaskId(payload.kind, payload.jobId) : null;

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
      // Дедупликация: детерминированный ID той же задачи не создаёт дубль.
      // Полное имя строим официальным `taskPath` (parent + /tasks/<id>), а не
      // конкатенацией пользовательских строк; при отсутствии taskPath у клиента
      // (старые фейки в тестах) — тот же формат из официального parent + ID.
      ...(taskId
        ? {
            name:
              typeof client.taskPath === 'function'
                ? client.taskPath(projectId, location, queue, taskId)
                : `${parent}/tasks/${taskId}`,
          }
        : {}),
    };

    try {
      const [created] = await client.createTask({ parent, task });
      return { scheduled: true, name: created.name };
    } catch (err) {
      // Детерминированный ID → повторный enqueue той же задачи вернёт
      // ALREADY_EXISTS. Это идемпотентный успех, а не сбой: задача уже стоит.
      if (isAlreadyExistsError(err)) {
        return { scheduled: true, name: task.name ?? null, alreadyExists: true };
      }
      throw err;
    }
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
