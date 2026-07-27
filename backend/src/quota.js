// Лимиты публичной беты.
//
// Главное требование — атомарность: два одновременных /render не должны
// «проскочить» мимо квоты. Поэтому списание кредита выполняется внутри той же
// транзакции Firestore, что и резервирование отпечатка идемпотентности, а
// счётчики читаются и пишутся только внутри транзакции.
//
// Отмена задачи возвращает кредит: пользователь не должен платить квотой за
// работу, которую сам остановил.

import { ApiError } from './errors.js';

/** Стоимость рендера в кредитах по разрешению. */
export const CREDIT_COST = {
  hd720: 1,
  fullHd1080: 1,
  twoK1440: 2,
  fourK2160: 4,
};

export function creditCostFor(resolution) {
  return CREDIT_COST[resolution] ?? 1;
}

/** Ключ суток в UTC — счётчики живут по календарным дням. */
export function dayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

const GLOBAL_SCOPE = '_global';

function userDocId(uid, day) {
  return `u_${uid}_${day}`;
}
function globalDocId(day) {
  return `g_${GLOBAL_SCOPE}_${day}`;
}
function ipDocId(ip, day) {
  // IP может быть IPv6 с двоеточиями — они недопустимы в id документа.
  return `i_${ip.replace(/[^A-Za-z0-9]/g, '_')}_${day}`;
}

/**
 * Хранилище счётчиков. Транзакции обязаны быть настоящими: в облаке —
 * Firestore, локально — сериализация через очередь промисов, чтобы тесты
 * проверяли ту же логику без гонок.
 */
export class QuotaStore {
  constructor(db) {
    this.db = db;
    this.collection = 'renderQuota';
  }

  async runTransaction(fn) {
    return this.db.runTransaction(fn);
  }
}

/**
 * Проверяет и списывает квоту рендера.
 *
 * Возвращает описание списания, чтобы его можно было вернуть при отмене.
 * Все проверки — внутри одной транзакции: между чтением и записью никто не
 * успеет вклиниться.
 */
export function buildQuotaOps({ limits, store }) {
  /**
   * @param tx        активная транзакция Firestore
   * @param uid       проверенный uid из токена
   * @param ip        адрес клиента (вторая ось ограничения)
   * @param cost      стоимость в кредитах
   * @param activeUser сколько задач пользователя уже активно
   * @param activeGlobal сколько задач активно во всей системе
   */
  async function reserveRender(tx, { uid, ip, cost, activeUser, activeGlobal, day }) {
    const d = day || dayKey();
    const userRef = store.db.collection(store.collection).doc(userDocId(uid, d));
    const globalRef = store.db.collection(store.collection).doc(globalDocId(d));
    const ipRef = ip ? store.db.collection(store.collection).doc(ipDocId(ip, d)) : null;

    // ВСЕ чтения — до первой записи: этого требует Firestore.
    const [userSnap, globalSnap, ipSnap] = await Promise.all([
      tx.get(userRef),
      tx.get(globalRef),
      ipRef ? tx.get(ipRef) : Promise.resolve(null),
    ]);

    const userUsed = userSnap.exists ? userSnap.data().renderCredits || 0 : 0;
    const globalUsed = globalSnap.exists ? globalSnap.data().renderCredits || 0 : 0;
    const ipUsed = ipSnap?.exists ? ipSnap.data().renderCredits || 0 : 0;

    // Активные задачи — жёсткие потолки, они защищают от расходов сильнее квоты.
    if (activeUser >= limits.maxActiveJobsPerUser) {
      throw new ApiError(
        'TOO_MANY_ACTIVE_JOBS',
        `Уже идёт рендер. Дождитесь его завершения или отмените.`,
      );
    }
    if (activeGlobal >= limits.maxActiveJobsGlobal) {
      throw new ApiError(
        'TOO_MANY_ACTIVE_JOBS_GLOBAL',
        'Сервис сейчас загружен. Попробуйте через несколько минут.',
      );
    }

    // Глобальный лимит проверяем раньше пользовательского: если исчерпан он,
    // пользователю честнее сказать про сервис, а не про его личную квоту.
    if (globalUsed + cost > limits.globalDailyCredits) {
      throw new ApiError(
        'GLOBAL_DAILY_LIMIT_REACHED',
        'Дневной лимит бесплатной беты исчерпан. Попробуйте завтра.',
      );
    }
    if (userUsed + cost > limits.userDailyCredits) {
      throw new ApiError(
        'DAILY_LIMIT_REACHED',
        `Дневной лимит исчерпан: ${limits.userDailyCredits} рендеров в сутки. Обновится завтра.`,
      );
    }
    if (ipRef && ipUsed + cost > limits.ipDailyCredits) {
      throw new ApiError(
        'DAILY_LIMIT_REACHED',
        'Дневной лимит для этого подключения исчерпан. Попробуйте завтра.',
      );
    }

    const stamp = new Date().toISOString();
    tx.set(userRef, { scope: 'user', uid, day: d, renderCredits: userUsed + cost, updatedAt: stamp }, { merge: true });
    tx.set(globalRef, { scope: 'global', day: d, renderCredits: globalUsed + cost, updatedAt: stamp }, { merge: true });
    if (ipRef) {
      tx.set(ipRef, { scope: 'ip', day: d, renderCredits: ipUsed + cost, updatedAt: stamp }, { merge: true });
    }

    return { uid, ip, cost, day: d };
  }

  /** Возврат кредита при отмене — списание не должно быть безвозвратным. */
  async function refundRender(charge) {
    if (!charge || !charge.cost) return;
    const { uid, ip, cost, day } = charge;
    await store.runTransaction(async (tx) => {
      const userRef = store.db.collection(store.collection).doc(userDocId(uid, day));
      const globalRef = store.db.collection(store.collection).doc(globalDocId(day));
      const ipRef = ip ? store.db.collection(store.collection).doc(ipDocId(ip, day)) : null;

      const [userSnap, globalSnap, ipSnap] = await Promise.all([
        tx.get(userRef),
        tx.get(globalRef),
        ipRef ? tx.get(ipRef) : Promise.resolve(null),
      ]);

      const dec = (snap, ref, scope) => {
        if (!snap?.exists) return;
        const used = snap.data().renderCredits || 0;
        tx.set(
          ref,
          { scope, renderCredits: Math.max(0, used - cost), updatedAt: new Date().toISOString() },
          { merge: true },
        );
      };
      dec(userSnap, userRef, 'user');
      dec(globalSnap, globalRef, 'global');
      if (ipRef) dec(ipSnap, ipRef, 'ip');
    });
  }

  /** Лимит вызовов Gemini — отдельная ось, планирование тоже стоит денег. */
  async function consumeEditPlan(uid, ip) {
    const d = dayKey();
    await store.runTransaction(async (tx) => {
      const userRef = store.db.collection(store.collection).doc(userDocId(uid, d));
      const ipRef = ip ? store.db.collection(store.collection).doc(ipDocId(ip, d)) : null;
      const [userSnap, ipSnap] = await Promise.all([
        tx.get(userRef),
        ipRef ? tx.get(ipRef) : Promise.resolve(null),
      ]);

      const used = userSnap.exists ? userSnap.data().editPlanCalls || 0 : 0;
      if (used + 1 > limits.editPlanDaily) {
        throw new ApiError(
          'EDIT_PLAN_LIMIT_REACHED',
          `Дневной лимит запросов к AI исчерпан: ${limits.editPlanDaily} в сутки.`,
        );
      }
      const ipUsed = ipSnap?.exists ? ipSnap.data().editPlanCalls || 0 : 0;
      if (ipRef && ipUsed + 1 > limits.editPlanDaily * 3) {
        throw new ApiError('EDIT_PLAN_LIMIT_REACHED', 'Слишком много запросов с этого подключения.');
      }

      const stamp = new Date().toISOString();
      tx.set(userRef, { scope: 'user', uid, day: d, editPlanCalls: used + 1, updatedAt: stamp }, { merge: true });
      if (ipRef) {
        tx.set(ipRef, { scope: 'ip', day: d, editPlanCalls: ipUsed + 1, updatedAt: stamp }, { merge: true });
      }
    });
  }

  /** Остаток для показа в профиле. */
  async function usageOf(uid) {
    const d = dayKey();
    const userSnap = await store.db.collection(store.collection).doc(userDocId(uid, d)).get();
    const globalSnap = await store.db.collection(store.collection).doc(globalDocId(d)).get();
    const used = userSnap.exists ? userSnap.data().renderCredits || 0 : 0;
    const editPlanUsed = userSnap.exists ? userSnap.data().editPlanCalls || 0 : 0;
    const globalUsed = globalSnap.exists ? globalSnap.data().renderCredits || 0 : 0;
    return {
      day: d,
      renderCreditsLimit: limits.userDailyCredits,
      renderCreditsUsed: used,
      renderCreditsRemaining: Math.max(0, limits.userDailyCredits - used),
      editPlanLimit: limits.editPlanDaily,
      editPlanUsed,
      editPlanRemaining: Math.max(0, limits.editPlanDaily - editPlanUsed),
      globalCreditsRemaining: Math.max(0, limits.globalDailyCredits - globalUsed),
      costs: { ...CREDIT_COST },
    };
  }

  /** Удаление счётчиков пользователя (при удалении аккаунта). */
  async function purgeUser(uid) {
    const snap = await store.db
      .collection(store.collection)
      .where('uid', '==', uid)
      .get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
    return snap.size;
  }

  return { reserveRender, refundRender, consumeEditPlan, usageOf, purgeUser };
}
