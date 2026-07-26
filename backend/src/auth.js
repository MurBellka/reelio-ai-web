// Аутентификация пользователя (Firebase Auth) и проверка App Check.
//
// Два независимых механизма, намеренно не связанных друг с другом:
//   • ID token отвечает на вопрос «кто это» → uid;
//   • App Check отвечает на вопрос «это вообще наше приложение» → защита от
//     ботов и скриптов.
// Провал любого из них не должен маскировать другой, поэтому проверяются
// раздельно и дают разные коды ошибок.
//
// НИ ОДИН токен не логируется и не попадает в тексты ошибок.

import { ApiError } from './errors.js';

/** Режимы App Check: выключен, наблюдение (не блокирует), принуждение. */
export const APP_CHECK_MODES = new Set(['off', 'monitor', 'enforce']);

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
      // checkRevoked: отозванный/выключенный аккаунт не должен работать до
      // истечения часа жизни токена.
      const decoded = await auth.verifyIdToken(token, true);
      return {
        uid: decoded.uid,
        email: decoded.email ?? null,
        emailVerified: Boolean(decoded.email_verified),
      };
    },
    async verifyAppCheckToken(token) {
      const decoded = await appCheck.verifyToken(token);
      return { appId: decoded.appId };
    },
    async deleteUser(uid) {
      await auth.deleteUser(uid);
    },
  };
}

export async function createVerifier(config) {
  if (config.auth?.verifier) return config.auth.verifier; // подмена в тестах
  if (!config.firebase?.projectId) return null; // local mode без Firebase
  return createFirebaseVerifier(config);
}

/** Достаёт Bearer-токен, не раскрывая его в сообщениях. */
function bearerOf(req) {
  const raw = req.get('Authorization') || '';
  if (!raw.startsWith('Bearer ')) return '';
  return raw.slice(7).trim();
}

/**
 * Требует подтверждённого пользователя Firebase.
 *
 * uid берётся ТОЛЬКО из проверенного токена. Никакие поля тела запроса
 * (uid, ownerUid, projectId) не могут на него повлиять.
 */
export function requireAuth({ verifier, config }) {
  return function authMiddleware(req, _res, next) {
    // Аварийный обход только для локальной разработки, в облаке недоступен.
    if (config.auth?.disabled) {
      req.auth = { uid: config.auth.devUid || 'devuser', email: 'dev@local', emailVerified: true };
      return next();
    }

    const token = bearerOf(req);
    if (!token) {
      return next(new ApiError('UNAUTHENTICATED', 'Требуется вход в аккаунт.'));
    }
    if (!verifier) {
      return next(new ApiError('UNAUTHENTICATED', 'Аутентификация не настроена на сервере.'));
    }

    verifier
      .verifyIdToken(token)
      .then((user) => {
        if (!user.emailVerified) {
          throw new ApiError(
            'EMAIL_NOT_VERIFIED',
            'Подтвердите адрес электронной почты, чтобы продолжить.',
          );
        }
        req.auth = user;
        next();
      })
      .catch((err) => {
        if (err instanceof ApiError) return next(err);
        // Причину провала наружу не раскрываем: истёкший, поддельный и
        // отозванный токен для клиента неразличимы.
        next(new ApiError('UNAUTHENTICATED', 'Сессия недействительна. Войдите заново.'));
      });
  };
}

/**
 * Проверка App Check — независимо от Firebase Auth.
 *
 * `monitor` предназначен для выката: результат пишется в лог, но запрос не
 * блокируется. Так видно реальную долю легитимных клиентов без App Check
 * прежде, чем включать `enforce`.
 */
export function appCheckGuard({ verifier, config }) {
  const mode = APP_CHECK_MODES.has(config.appCheck?.mode) ? config.appCheck.mode : 'off';

  return function appCheckMiddleware(req, _res, next) {
    if (mode === 'off' || !verifier) return next();

    const token = (req.get('X-Firebase-AppCheck') || '').trim();
    const reject = (reason) => {
      if (mode === 'enforce') {
        return next(new ApiError('APP_CHECK_FAILED', 'Запрос отклонён проверкой приложения.'));
      }
      // monitor: только факт, без самого токена.
      console.warn(`[app-check] ${reason} path=${req.path} mode=${mode}`);
      return next();
    };

    if (!token) return reject('missing');

    verifier
      .verifyAppCheckToken(token)
      .then(() => next())
      .catch(() => reject('invalid'));
  };
}
