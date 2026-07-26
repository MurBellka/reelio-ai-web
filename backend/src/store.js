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

  async countActiveJobs(projectId) {
    let n = 0;
    for (const job of this.jobs.values()) {
      if (job.projectId === projectId && !TERMINAL_STATUSES.has(job.status)) n += 1;
    }
    return n;
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

  async countActiveJobs(projectId) {
    const snap = await this.db
      .collection(JOBS)
      .where('projectId', '==', projectId)
      .where('status', 'in', ['queued', 'running'])
      .count()
      .get();
    return snap.data().count;
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
