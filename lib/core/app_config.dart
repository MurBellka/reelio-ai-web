/// Конфигурация приложения времени сборки.
///
/// Значения задаются через `--dart-define` и **не содержат секретов**.
/// Gemini API key никогда не попадает в клиент — он живёт только в backend'е.
class AppConfig {
  const AppConfig._();

  /// URL защищённого backend'а (`https://…/api`). Пусто → Demo Mode (Mock).
  ///
  /// Пример: `flutter build web --dart-define=REELIO_BACKEND_URL=https://api.example.com`
  static const String backendBaseUrl = String.fromEnvironment(
    'REELIO_BACKEND_URL',
    defaultValue: '',
  );

  /// Явно включённый демо-режим (мок-планировщик) даже при заданном backend.
  static const bool forceDemoMode = bool.fromEnvironment(
    'REELIO_DEMO_MODE',
    defaultValue: false,
  );

  /// Есть ли настоящий backend для Gemini.
  static bool get hasBackend => backendBaseUrl.isNotEmpty && !forceDemoMode;

  /// Работает ли приложение в демонстрационном режиме (без Gemini).
  static bool get isDemoMode => !hasBackend;

  /// Таймаут запроса к backend/Gemini.
  static const Duration requestTimeout = Duration(seconds: 30);

  /// Количество повторов при временной ошибке (5xx/сеть/таймаут).
  static const int maxRetries = 2;

  /// Минимальный интервал между запросами генерации (клиентский rate limit).
  static const Duration minRequestInterval = Duration(seconds: 3);
}
