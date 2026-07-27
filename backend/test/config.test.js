// Fail-closed проверки конфигурации.
//
// Смысл в том, чтобы опасная конфигурация роняла процесс на старте. Ошибка
// запуска заметна сразу; публичный API без авторизации может работать неделями,
// пока кто-нибудь не наткнётся.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assertSafeConfig, isCloudRuntime } from '../src/config.js';

function cfg(overrides = {}) {
  return {
    auth: { disabled: false },
    firebase: { projectId: 'test-project' },
    render: { mode: 'cloud' },
    media: { verify: true, mountPath: '/mnt/media' },
    ...overrides,
  };
}

describe('признак облачного окружения', () => {
  it('распознаётся по переменным Cloud Run', () => {
    assert.equal(isCloudRuntime({ K_SERVICE: 'reelio-backend' }), true);
    assert.equal(isCloudRuntime({ K_REVISION: 'reelio-backend-00001' }), true);
    assert.equal(isCloudRuntime({ CLOUD_RUN_JOB: 'worker' }), true);
  });

  it('локальный запуск облачным не считается', () => {
    assert.equal(isCloudRuntime({}), false);
    assert.equal(isCloudRuntime({ NODE_ENV: 'production' }), false);
  });
});

describe('обход авторизации', () => {
  it('в облаке запрещён — процесс не должен стартовать', () => {
    assert.throws(
      () => assertSafeConfig(cfg({ auth: { disabled: true } }), { K_SERVICE: 'reelio-backend' }),
      /AUTH_DISABLED/,
      'облачный запуск с обходом входа обязан падать',
    );
  });

  it('локально разрешён — это режим разработки', () => {
    assert.doesNotThrow(() =>
      assertSafeConfig(
        cfg({ auth: { disabled: true }, render: { mode: 'local' }, media: { verify: false } }),
        {},
      ),
    );
  });

  it('признак облака берётся из окружения Cloud Run, а не из своей конфигурации', () => {
    // Тот, кто выкатывает обход авторизации, мог бы «забыть» и собственные
    // переменные, поэтому опираемся на K_SERVICE, который задаёт платформа.
    assert.throws(
      () => assertSafeConfig(cfg({ auth: { disabled: true }, render: { mode: 'local' } }), {
        K_SERVICE: 'reelio-backend',
      }),
      /AUTH_DISABLED/,
    );
  });
});

describe('обязательные параметры облачного режима', () => {
  it('без FIREBASE_PROJECT_ID старт запрещён', () => {
    assert.throws(
      () => assertSafeConfig(cfg({ firebase: { projectId: '' } }), {}),
      /FIREBASE_PROJECT_ID/,
    );
  });

  it('без монтирования бакета старт запрещён', () => {
    // Иначе проверка видит только начало файла и отвергает корректные видео с
    // метаданными в конце — тихая деградация вместо явного отказа.
    assert.throws(
      () => assertSafeConfig(cfg({ media: { verify: true, mountPath: '' } }), {}),
      /GCS_MOUNT_PATH/,
    );
  });

  it('с выключенной проверкой медиа монтирование не требуется', () => {
    assert.doesNotThrow(() =>
      assertSafeConfig(cfg({ media: { verify: false, mountPath: '' } }), {}),
    );
  });

  it('корректная облачная конфигурация проходит', () => {
    assert.doesNotThrow(() => assertSafeConfig(cfg(), { K_SERVICE: 'reelio-backend' }));
  });
});
