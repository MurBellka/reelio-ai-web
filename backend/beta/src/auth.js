// Аутентификация (Firebase Auth) и проверка приложения (App Check) — §2 долга.
//
// Два механизма намеренно НЕ связаны друг с другом:
//   • ID token отвечает на вопрос «кто это» → uid;
//   • App Check отвечает на вопрос «это вообще наше приложение» → защита от
//     ботов и посторонних скриптов.
//
// Провал одного не должен маскировать другой: у них разные коды ошибок, разные
// middleware и независимые режимы. В частности, App Check можно перевести в
// режим наблюдения, не ослабляя аутентификацию.
//
// НИ ОДИН токен не логируется и не попадает в тексты ошибок.

import { ApiError } from './errors.js';

/** Режимы App Check: выключен, наблюдение (не блокирует), принуждение. */
export const APP_CHECK_MODES = new Set(['off', 'monitor', 'enforce']);

/** Достаёт Bearer-токен, не раскрывая его в ошибках. */
function bearerToken(req) {
  const header = req.get?.('authorization') ?? req.headers?.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  return match ? match[1].trim() : null;
}

/**
 * Верификатор на firebase-admin. Создаётся лениво: в local mode и в тестах
 * пакет не нужен, поэтому импорт динамический.
 */
async function createFirebaseVerifier(config) {
  const { initializeApp, getApps, applicationDefault } = await import('firebase-admin/app');
  const { getAuth } = await import('firebase-admin/auth');
  const { getAppCheck } = await import('firebase-admin/app-check');

  // ADC / Workload Identity — ключей сервисных аккаунтов нет.
  const app = getApps().length
    ? getApps()[0]
    : initializeApp({ credential: applicationDefault(), projectId: config.firebase.projectId });

  const auth = getAuth(app);
  const appCheck = getAppCheck(app);

  return {
    async verifyIdToken(token) {
      // checkRevoked: отозванный аккаунт не должен работать до истечения часа.
      const decoded = await auth.verifyIdToken(token, true);
      return { uid: decoded.uid, emailVerified: Boolean(decoded.email_verified) };
    },
    async verifyAppCheckToken(token) {
      const decoded = await appCheck.verifyToken(token);
      return { appId: decoded.appId };
    },
  };
}

export async function createVerifier(config) {
  if (config.auth?.verifier) return config.auth.verifier; // подмена в тестах
  if (!config.firebase?.projectId) return null; // local mode без Firebase
  return createFirebaseVerifier(config);
}

/**
 * Middleware аутентификации. Ставит `req.uid`.
 *
 * Без верификатора (local mode) uid берётся из заголовка — это допустимо
 * только когда Firebase не сконфигурирован, то есть в разработке и тестах.
 */
export function requireAuth({ verifier, config }) {
  return async (req, _res, next) => {
    try {
      if (!verifier) {
        const devUid = req.get?.('x-debug-uid');
        if (!config?.allowInsecureAuth || !devUid) {
          throw new ApiError('UNAUTHENTICATED', 'Требуется вход в аккаунт.');
        }
        req.uid = devUid;
        return next();
      }

      const token = bearerToken(req);
      if (!token) throw new ApiError('UNAUTHENTICATED', 'Требуется вход в аккаунт.');

      let decoded;
      try {
        decoded = await verifier.verifyIdToken(token);
      } catch (err) {
        // Причина провала наружу не уходит: она подсказывала бы атакующему.
        throw new ApiError('UNAUTHENTICATED', 'Сессия недействительна, войдите заново.', {
          detail: `verifyIdToken failed: ${err?.code ?? err?.message ?? 'unknown'}`,
        });
      }

      if (!decoded?.uid) throw new ApiError('UNAUTHENTICATED', 'Сессия недействительна.');
      req.uid = decoded.uid;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

/**
 * Middleware App Check. Не трогает `req.uid` и не зависит от аутентификации.
 *
 * `monitor` — проверяем и логируем, но пропускаем: так включают App Check на
 * живом трафике, не ломая старых клиентов.
 */
export function appCheckGuard({ verifier, mode = 'off' }) {
  const effective = APP_CHECK_MODES.has(mode) ? mode : 'off';

  return async (req, _res, next) => {
    if (effective === 'off' || !verifier) return next();

    const token = req.get?.('x-firebase-appcheck');
    const fail = (detail) => {
      if (effective === 'enforce') {
        return next(
          new ApiError('APP_CHECK_FAILED', 'Запрос отклонён проверкой приложения.', { detail }),
        );
      }
      req.log?.warn?.('app check failed (monitor)', { detail });
      return next();
    };

    if (!token) return fail('missing token');

    try {
      await verifier.verifyAppCheckToken(token);
      return next();
    } catch (err) {
      return fail(`verifyAppCheckToken failed: ${err?.code ?? 'unknown'}`);
    }
  };
}

/**
 * Проверка владения объектом (§3 долга — изоляция по uid).
 *
 * Схему путей задаёт сервер, и в неё зашит проверенный uid. Клиент не может
 * прислать путь к чужим материалам: любой путь вне своего префикса отвергается
 * ещё до того, как дойдёт до хранилища.
 */
export function projectPrefixFor(uid, projectId) {
  return `users/${uid}/projects/${projectId}/`;
}

export function assertOwnedPath(objectPath, uid, projectId, field = 'objectPath') {
  const prefix = projectPrefixFor(uid, projectId);

  if (typeof objectPath !== 'string' || !objectPath) {
    throw new ApiError('INVALID_OBJECT_PATH', 'Путь объекта не указан.', { field });
  }
  if (objectPath.includes('..') || objectPath.includes('//') || objectPath.startsWith('/')) {
    throw new ApiError('INVALID_OBJECT_PATH', 'Недопустимый путь объекта.', { field });
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(objectPath)) {
    throw new ApiError('INVALID_OBJECT_PATH', 'Путь объекта содержит недопустимые символы.', { field });
  }
  if (!objectPath.startsWith(prefix)) {
    // Формулировка одинакова и для «чужого», и для «несуществующего»: иначе по
    // тексту ошибки можно было бы выяснять, какие проекты есть у других.
    throw new ApiError('FORBIDDEN', 'Материал недоступен.', { field });
  }
  return objectPath;
}
