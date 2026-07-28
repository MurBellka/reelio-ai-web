// Состояние анализа и счётчики квот (§3, §4, §5 долга).
//
// Три вещи, которые обязаны быть атомарными, иначе лимиты обходятся гонкой:
//   • резервирование отпечатка идемпотентности (create-only);
//   • списание суточной квоты;
//   • переход задачи в терминальный статус.
// Все три выполняются внутри одной транзакции.
//
// Реализация здесь — в памяти, с настоящей сериализацией через очередь
// промисов: два одновременных запроса действительно выстраиваются в очередь,
// поэтому тесты проверяют ту же логику, что будет работать в Firestore.
// Облачная реализация подставляется через тот же интерфейс `runTransaction`.

import { createHash } from 'node:crypto';

/** ULID-подобный идентификатор, монотонный по времени и безопасный для путей. */
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function newId(prefix) {
  let ts = Date.now();
  let time = '';
  for (let i = 0; i < 10; i += 1) {
    time = B32[ts % 32] + time;
    ts = Math.floor(ts / 32);
  }
  const rand = Array.from({ length: 10 }, () => B32[Math.floor(Math.random() * 32)]).join('');
  return `${prefix}_${time}${rand}`;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** Ключ суток в UTC — счётчики живут по календарным дням. */
export function dayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/**
 * §5 — отпечаток АНАЛИЗА одного материала.
 *
 * Считается от содержимого, а не от идентификатора, который прислал клиент.
 * Это принципиально: если бы ключом был assetId, клиент мог бы переименовать
 * материал и получить «новый» анализ, а мог бы, наоборот, выдать чужой id за
 * свой. Хеш содержимого исключает и то, и другое:
 *   • тот же файл → тот же отпечаток → результат берётся из кэша, Gemini не
 *     вызывается, квота не списывается;
 *   • другой файл → другой отпечаток → честный вызов и честное списание.
 *
 * uid входит в отпечаток, поэтому кэш одного пользователя недоступен другому,
 * даже если файл байт в байт совпадает.
 */
export function analysisFingerprint({ uid, contentHash, analysisVersion, model }) {
  return sha256(`${uid}:${contentHash}:${analysisVersion}:${model}`);
}

/**
 * §4 — отпечаток ЗАПРОСА на анализ проекта.
 *
 * Повтор того же запроса обязан вернуть ту же задачу, а не создать новую.
 */
export function requestFingerprint({ uid, projectId, idempotencyKey, contentHash }) {
  const key = idempotencyKey || contentHash;
  return sha256(`${uid}:${projectId}:${key}`);
}

/** Терминальные статусы задачи анализа. */
export const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

/**
 * Хранилище в памяти с сериализацией транзакций.
 *
 * Очередь промисов — не «упрощение для тестов», а корректная модель: Firestore
 * тоже сериализует конфликтующие транзакции, просто делает это распределённо.
 */
export class MemoryStore {
  /** Тип хранилища — облачный guard запрещает 'memory' в cloud mode (§4A.5). */
  kind = 'memory';

  constructor() {
    this.analyses = new Map(); // fingerprint → MediaAnalysis (кэш §5)
    this.jobs = new Map(); // jobId → job анализа
    this.jobsByFingerprint = new Map(); // requestFingerprint → jobId анализа
    this.renderJobs = new Map(); // jobId → задача рендера (§4B.3)
    this.renderJobsByFingerprint = new Map(); // fingerprint → jobId рендера
    this.counters = new Map(); // docId → { count }
    this.tail = Promise.resolve();
  }

  /** Выполняет функцию в эксклюзивном контексте. Вложенность не допускается. */
  runTransaction(fn) {
    const result = this.tail.then(() => fn(this));
    // Хвост не должен «застревать» на отказе одной транзакции.
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  // ── Кэш анализа (§5) ────────────────────────────────────────────────────

  getAnalysis(fingerprint) {
    return this.analyses.get(fingerprint) ?? null;
  }

  putAnalysis(fingerprint, analysis) {
    this.analyses.set(fingerprint, { ...analysis, cachedAt: new Date().toISOString() });
  }

  // ── Задачи ──────────────────────────────────────────────────────────────

  getJob(jobId) {
    return this.jobs.get(jobId) ?? null;
  }

  findJobByFingerprint(fingerprint) {
    const jobId = this.jobsByFingerprint.get(fingerprint);
    return jobId ? this.getJob(jobId) : null;
  }

  putJob(job) {
    this.jobs.set(job.id, job);
    if (job.fingerprint) this.jobsByFingerprint.set(job.fingerprint, job.id);
    return job;
  }

  /** Активные задачи пользователя — для лимита одновременных анализов. */
  countActiveJobs(uid) {
    let active = 0;
    for (const job of this.jobs.values()) {
      if (job.uid === uid && !TERMINAL_STATUSES.has(job.status)) active += 1;
    }
    return active;
  }

  // ── Задачи рендера (§4B.3) ────────────────────────────────────────────────

  getRenderJob(jobId) {
    return this.renderJobs.get(jobId) ?? null;
  }

  findRenderJobByFingerprint(fingerprint) {
    const jobId = this.renderJobsByFingerprint.get(fingerprint);
    return jobId ? this.getRenderJob(jobId) : null;
  }

  putRenderJob(job) {
    this.renderJobs.set(job.id, job);
    if (job.fingerprint) this.renderJobsByFingerprint.set(job.fingerprint, job.id);
    return job;
  }

  countActiveRenderJobs(uid) {
    let active = 0;
    for (const job of this.renderJobs.values()) {
      if (job.uid === uid && !TERMINAL_STATUSES.has(job.status)) active += 1;
    }
    return active;
  }

  // ── Счётчики квот ───────────────────────────────────────────────────────

  readCounter(docId) {
    return this.counters.get(docId)?.count ?? 0;
  }

  writeCounter(docId, count) {
    this.counters.set(docId, { count });
  }
}

/**
 * Облачный guard (§4A.5): в cloud mode MemoryStore запрещён. Иначе несколько
 * инстансов Cloud Run держали бы РАЗНЫЕ счётчики квот, кэш и отпечатки
 * идемпотентности — лимиты обходились бы простым распараллеливанием, а
 * незавершённые задачи терялись бы при перезапуске инстанса.
 */
export function assertStoreForMode(config, store) {
  if (config.mode === 'cloud' && store?.kind !== 'firestore') {
    throw new Error(
      'REFUSING TO START: cloud mode требует Firestore-хранилища, ' +
        `получено «${store?.kind ?? 'unknown'}». MemoryStore допустим только ` +
        'локально и в тестах (§4A.5).',
    );
  }
}

/**
 * Фабрика хранилища. Локально/в тестах — MemoryStore; в облаке —
 * FirestoreStore (грузится динамически, чтобы юнит-тесты не тянули SDK).
 */
export async function createStore(config) {
  if (config.storeKind === 'firestore') {
    const { FirestoreStore } = await import('./store-firestore.js');
    const store = await FirestoreStore.create(config);
    assertStoreForMode(config, store);
    return store;
  }
  const store = new MemoryStore();
  assertStoreForMode(config, store);
  return store;
}

/**
 * Операции квот поверх хранилища (§3).
 *
 * Списание всегда происходит ВНУТРИ транзакции вызывающего кода: отдельный
 * «сначала проверить, потом списать» — это и есть гонка, ради устранения
 * которой всё затевалось.
 */
export function buildQuotaOps({ limits, store }) {
  const userDoc = (uid, day) => `u_${uid}_${day}`;
  const projectDoc = (uid, projectId, day) => `p_${uid}_${projectId}_${day}`;

  // Методы await-совместимы: MemoryStore возвращает значения синхронно,
  // Firestore — через промис. `await` числа — no-op, поэтому один и тот же код
  // работает с обеими реализациями.
  return {
    /** Текущее потребление — для показа пользователю. */
    async usage(uid, projectId, now = new Date()) {
      const day = dayKey(now);
      return {
        day,
        user: await store.readCounter(userDoc(uid, day)),
        userLimit: limits.perUserPerDay,
        project: projectId ? await store.readCounter(projectDoc(uid, projectId, day)) : 0,
        projectLimit: limits.perProjectPerDay,
      };
    },

    /**
     * Проверяет и списывает одну единицу анализа. Вызывается внутри транзакции.
     * @throws {{code: string}} при исчерпании лимита
     */
    async charge(tx, { uid, projectId, now = new Date() }) {
      const day = dayKey(now);
      const uDoc = userDoc(uid, day);
      const pDoc = projectDoc(uid, projectId, day);

      const userCount = await tx.readCounter(uDoc);
      if (userCount >= limits.perUserPerDay) {
        const err = new Error('Суточный лимит анализов исчерпан.');
        err.code = 'DAILY_LIMIT_REACHED';
        throw err;
      }

      const projectCount = await tx.readCounter(pDoc);
      if (projectCount >= limits.perProjectPerDay) {
        const err = new Error('Лимит анализов для этого проекта исчерпан.');
        err.code = 'PROJECT_LIMIT_REACHED';
        throw err;
      }

      await tx.writeCounter(uDoc, userCount + 1);
      await tx.writeCounter(pDoc, projectCount + 1);
      return { user: userCount + 1, project: projectCount + 1 };
    },

    /** Возврат квоты: за отменённую работу платить не должны. */
    async refund(tx, { uid, projectId, now = new Date() }) {
      const day = dayKey(now);
      const uDoc = userDoc(uid, day);
      const pDoc = projectDoc(uid, projectId, day);

      await tx.writeCounter(uDoc, Math.max(0, (await tx.readCounter(uDoc)) - 1));
      await tx.writeCounter(pDoc, Math.max(0, (await tx.readCounter(pDoc)) - 1));
    },
  };
}
