// Хранилище состояния задач рендера.
//
// cloud → Firestore (коллекции renderJobs и renderIdempotency);
// local → память (для end-to-end тестов без платных ресурсов).
//
// Резервирование отпечатка идемпотентности выполняется транзакционно
// (create-only), поэтому два одновременных POST /render дают одну задачу (§5).

import { TERMINAL_STATUSES } from './contract.js';

const JOBS = 'renderJobs';
const KEYS = 'renderIdempotency';

class MemoryStore {
  constructor() {
    this.jobs = new Map();
    this.keys = new Map();
  }

  async createJob(job) {
    this.jobs.set(job.jobId, structuredClone(job));
    return job;
  }

  async getJob(jobId) {
    const job = this.jobs.get(jobId);
    return job ? structuredClone(job) : null;
  }

  /**
   * Атомарно применяет patch. `mutate(job)` может вернуть null, чтобы отменить
   * запись (например, задача уже терминальна).
   */
  async updateJob(jobId, mutate) {
    const current = this.jobs.get(jobId);
    if (!current) return null;
    const next = mutate(structuredClone(current));
    if (!next) return structuredClone(current);
    this.jobs.set(jobId, structuredClone(next));
    return structuredClone(next);
  }

  /** create-only: возвращает { created, record }. */
  async reserveFingerprint(fingerprint, record) {
    const existing = this.keys.get(fingerprint);
    if (existing) return { created: false, record: structuredClone(existing) };
    this.keys.set(fingerprint, structuredClone(record));
    return { created: true, record: structuredClone(record) };
  }

  async rebindFingerprint(fingerprint, record) {
    this.keys.set(fingerprint, structuredClone(record));
  }

  async countActiveJobs(ownerUid) {
    let n = 0;
    for (const job of this.jobs.values()) {
      if (job.ownerUid === ownerUid && !TERMINAL_STATUSES.has(job.status)) n += 1;
    }
    return n;
  }

  async countActiveJobsGlobal() {
    let n = 0;
    for (const job of this.jobs.values()) {
      if (!TERMINAL_STATUSES.has(job.status)) n += 1;
    }
    return n;
  }

  async listJobsByOwner(ownerUid, projectId = null) {
    return [...this.jobs.values()]
      .filter((j) => j.ownerUid === ownerUid && (!projectId || j.projectId === projectId))
      .map((j) => structuredClone(j));
  }

  async deleteJob(jobId) {
    this.jobs.delete(jobId);
  }

  /**
   * Сериализованная «транзакция» для квот в local mode.
   *
   * Настоящей изоляции здесь нет, но есть главное свойство, ради которого
   * транзакция и нужна: операции не перемежаются. Благодаря этому тест на
   * параллельный обход квоты проверяет ту же логику, что работает в облаке.
   */
  runTransaction(fn) {
    const run = async () => {
      const writes = [];
      const tx = {
        get: async (ref) => ref.get(),
        set: (ref, data, opts) => writes.push(() => ref.set(data, opts)),
        create: (ref, data) => writes.push(() => ref.create(data)),
        delete: (ref) => writes.push(() => ref.delete()),
      };
      const result = await fn(tx);
      for (const w of writes) await w();
      return result;
    };
    this.txChain = (this.txChain || Promise.resolve()).then(run, run);
    return this.txChain;
  }

  /** Минимальный аналог Firestore-коллекции для счётчиков квот. */
  collection(name) {
    this.docs = this.docs || new Map();
    const store = this.docs;
    const key = (id) => `${name}/${id}`;
    return {
      doc: (id) => ({
        id,
        get: async () => {
          const data = store.get(key(id));
          return { exists: data !== undefined, data: () => structuredClone(data) };
        },
        set: async (data, opts) => {
          const prev = opts?.merge ? store.get(key(id)) || {} : {};
          store.set(key(id), { ...prev, ...structuredClone(data) });
        },
        delete: async () => store.delete(key(id)),
      }),
      where: (field, _op, value) => ({
        get: async () => {
          const docs = [];
          for (const [k, v] of store.entries()) {
            if (k.startsWith(`${name}/`) && v[field] === value) {
              docs.push({ data: () => structuredClone(v), ref: { delete: async () => store.delete(k) } });
            }
          }
          return { size: docs.length, docs };
        },
      }),
    };
  }

  async listStaleRunningJobs(olderThanIso) {
    return [...this.jobs.values()]
      .filter((j) => !TERMINAL_STATUSES.has(j.status) && j.updatedAt < olderThanIso)
      .map((j) => structuredClone(j));
  }
}

class FirestoreStore {
  constructor(db) {
    this.db = db;
  }

  async createJob(job) {
    await this.db.collection(JOBS).doc(job.jobId).create(job);
    return job;
  }

  async getJob(jobId) {
    const snap = await this.db.collection(JOBS).doc(jobId).get();
    return snap.exists ? snap.data() : null;
  }

  async updateJob(jobId, mutate) {
    const ref = this.db.collection(JOBS).doc(jobId);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const current = snap.data();
      const next = mutate({ ...current });
      if (!next) return current;
      tx.set(ref, next);
      return next;
    });
  }

  async reserveFingerprint(fingerprint, record) {
    const ref = this.db.collection(KEYS).doc(fingerprint);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) return { created: false, record: snap.data() };
      tx.create(ref, record);
      return { created: true, record };
    });
  }

  async rebindFingerprint(fingerprint, record) {
    await this.db.collection(KEYS).doc(fingerprint).set(record);
  }

  async countActiveJobs(ownerUid) {
    const snap = await this.db
      .collection(JOBS)
      .where('ownerUid', '==', ownerUid)
      .where('status', 'in', ['queued', 'running'])
      .count()
      .get();
    return snap.data().count;
  }

  async countActiveJobsGlobal() {
    const snap = await this.db
      .collection(JOBS)
      .where('status', 'in', ['queued', 'running'])
      .count()
      .get();
    return snap.data().count;
  }

  async listJobsByOwner(ownerUid, projectId = null) {
    let q = this.db.collection(JOBS).where('ownerUid', '==', ownerUid);
    if (projectId) q = q.where('projectId', '==', projectId);
    const snap = await q.get();
    return snap.docs.map((d) => d.data());
  }

  async deleteJob(jobId) {
    await this.db.collection(JOBS).doc(jobId).delete();
  }

  runTransaction(fn) {
    return this.db.runTransaction(fn);
  }

  collection(name) {
    return this.db.collection(name);
  }

  async listStaleRunningJobs(olderThanIso) {
    const snap = await this.db
      .collection(JOBS)
      .where('status', 'in', ['queued', 'running'])
      .where('updatedAt', '<', olderThanIso)
      .limit(50)
      .get();
    return snap.docs.map((d) => d.data());
  }
}

export async function createStore(config) {
  if (config.render.mode !== 'cloud') return new MemoryStore();
  const { Firestore } = await import('@google-cloud/firestore');
  const db = new Firestore({
    projectId: config.render.gcpProject || undefined,
    databaseId: config.render.firestoreDatabase,
    // Аутентификация — только ADC / Workload Identity. Ключей SA нет.
  });
  return new FirestoreStore(db);
}

export { MemoryStore };
