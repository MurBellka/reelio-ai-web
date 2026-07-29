// Firestore-хранилище (§4A.4). Тот же интерфейс, что у MemoryStore, но
// состояние переживает перезапуск и общее для всех инстансов Cloud Run.
//
// SDK грузится динамически: юнит-тесты подставляют фейковый `db` и не тянут
// @google-cloud/firestore. Для реальной работы `create()` импортирует SDK.
//
// Транзакционный интерфейс await-совместим: MemoryStore возвращает значения
// синхронно, Firestore — через await t.get(...). Вызывающий код (analysis
// -service) всегда await'ит методы tx, поэтому обе реализации взаимозаменяемы.

import { TERMINAL_STATUSES } from './store.js';

/** Пути коллекций — плоские, без переменных сегментов в имени коллекции. */
const COL = {
  analyses: 'beta_analyses',
  jobs: 'beta_jobs',
  fpIndex: 'beta_job_fingerprints',
  counters: 'beta_counters',
  renderJobs: 'beta_render_jobs',
  renderFpIndex: 'beta_render_fingerprints',
};

/** Адаптер транзакции Firestore под интерфейс, который ждёт analysis-service. */
class FirestoreTx {
  constructor(db, t) {
    this.db = db;
    this.t = t;
  }

  async #getDoc(col, id) {
    const snap = await this.t.get(this.db.collection(col).doc(id));
    return snap.exists ? snap.data() : null;
  }

  async getAnalysis(fingerprint) {
    return this.#getDoc(COL.analyses, fingerprint);
  }

  async getJob(jobId) {
    return this.#getDoc(COL.jobs, jobId);
  }

  async findJobByFingerprint(fingerprint) {
    const idx = await this.#getDoc(COL.fpIndex, fingerprint);
    return idx?.jobId ? this.getJob(idx.jobId) : null;
  }

  async putJob(job) {
    const terminal = TERMINAL_STATUSES.has(job.status);
    const stored = { ...job, terminal };
    this.t.set(this.db.collection(COL.jobs).doc(job.id), stored);
    if (job.fingerprint) {
      this.t.set(this.db.collection(COL.fpIndex).doc(job.fingerprint), { jobId: job.id });
    }
    return stored;
  }

  async countActiveJobs(uid) {
    // Требует композитного индекса (uid ASC, terminal ASC) — см. deployment doc.
    const q = this.db
      .collection(COL.jobs)
      .where('uid', '==', uid)
      .where('terminal', '==', false);
    const snap = await this.t.get(q);
    return snap.size;
  }

  async readCounter(docId) {
    const data = await this.#getDoc(COL.counters, docId);
    return data?.count ?? 0;
  }

  async writeCounter(docId, count) {
    this.t.set(this.db.collection(COL.counters).doc(docId), { count });
  }

  // ── Render jobs (§4B) ─────────────────────────────────────────────────────
  async getRenderJob(jobId) {
    return this.#getDoc(COL.renderJobs, jobId);
  }

  async findRenderJobByFingerprint(fingerprint) {
    const idx = await this.#getDoc(COL.renderFpIndex, fingerprint);
    return idx?.jobId ? this.getRenderJob(idx.jobId) : null;
  }

  async putRenderJob(job) {
    const terminal = TERMINAL_STATUSES.has(job.status);
    this.t.set(this.db.collection(COL.renderJobs).doc(job.id), { ...job, terminal });
    if (job.fingerprint) {
      this.t.set(this.db.collection(COL.renderFpIndex).doc(job.fingerprint), { jobId: job.id });
    }
    return { ...job, terminal };
  }

  async countActiveRenderJobs(uid) {
    const q = this.db
      .collection(COL.renderJobs)
      .where('uid', '==', uid)
      .where('terminal', '==', false);
    const snap = await this.t.get(q);
    return snap.size;
  }
}

export class FirestoreStore {
  kind = 'firestore';

  constructor(db) {
    this.db = db;
  }

  /** Боевой конструктор: динамически грузит SDK. */
  static async create(config) {
    const { Firestore } = await import('@google-cloud/firestore');
    const db = new Firestore({ projectId: config.firebase.projectId });
    return new FirestoreStore(db);
  }

  runTransaction(fn) {
    return this.db.runTransaction((t) => fn(new FirestoreTx(this.db, t)));
  }

  // ── Не транзакционные чтения/записи (кэш и статусы) ────────────────────────
  async #get(col, id) {
    const snap = await this.db.collection(col).doc(id).get();
    return snap.exists ? snap.data() : null;
  }

  async getAnalysis(fingerprint) {
    return this.#get(COL.analyses, fingerprint);
  }

  async putAnalysis(fingerprint, analysis) {
    await this.db
      .collection(COL.analyses)
      .doc(fingerprint)
      .set({ ...analysis, cachedAt: new Date().toISOString() });
  }

  async getJob(jobId) {
    return this.#get(COL.jobs, jobId);
  }

  async getRenderJob(jobId) {
    return this.#get(COL.renderJobs, jobId);
  }

  /** Нетранзакционное чтение счётчика — для показа остатка квоты (quota.usage). */
  async readCounter(docId) {
    const data = await this.#get(COL.counters, docId);
    return data?.count ?? 0;
  }
}
