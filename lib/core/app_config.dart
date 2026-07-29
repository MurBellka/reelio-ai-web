/// Конфигурация приложения времени сборки.
///
/// Значения задаются через `--dart-define` и **не содержат секретов**.
/// Gemini API key никогда не попадает в клиент — он живёт только в backend'е.
class AppConfig {
  const AppConfig._();

  /// URL production v1 backend'а (`https://…`). Пусто → Demo Mode (Mock).
  ///
  /// Пример: `flutter build web --dart-define=REELIO_BACKEND_URL=https://api.example.com`
  static const String backendBaseUrl = String.fromEnvironment(
    'REELIO_BACKEND_URL',
    defaultValue: '',
  );

  /// URL beta backend'а v2 (§4C). Отдельный адрес; production не подменяет.
  static const String betaBackendBaseUrl = String.fromEnvironment(
    'REELIO_BETA_BACKEND_URL',
    defaultValue: '',
  );

  /// Feature flag v2 (§4C). По умолчанию `false` — приложение полностью
  /// сохраняет текущий публичный v1. При `true` весь поток (analysis, uploads,
  /// render, jobs, download) идёт ТОЛЬКО через [betaBackendBaseUrl].
  static const bool v2Enabled = bool.fromEnvironment(
    'REELIO_V2_ENABLED',
    defaultValue: false,
  );

  /// Явно включённый демо-режим (мок-планировщик) даже при заданном backend.
  static const bool forceDemoMode = bool.fromEnvironment(
    'REELIO_DEMO_MODE',
    defaultValue: false,
  );

  /// Активный backend: beta при включённом флаге, иначе production v1.
  /// Никакого смешивания — и analysis, и render берут ОДИН адрес.
  static String get activeBackendUrl =>
      v2Enabled ? betaBackendBaseUrl : backendBaseUrl;

  /// Включён ли режим v2 (флаг поднят и адрес беты задан).
  static bool get isV2Active => v2Enabled && betaBackendBaseUrl.isNotEmpty;

  /// Флаг v2 поднят, но адрес беты не задан: загружать файлы нельзя, нужно
  /// показать понятное сообщение о недоступности беты (§4C.7).
  static bool get betaUnavailable => v2Enabled && betaBackendBaseUrl.isEmpty;

  /// Есть ли настоящий backend (по активному адресу).
  static bool get hasBackend => activeBackendUrl.isNotEmpty && !forceDemoMode;

  /// Работает ли приложение в демонстрационном режиме (без Gemini).
  static bool get isDemoMode => !hasBackend;

  /// Таймаут запроса к backend/Gemini.
  static const Duration requestTimeout = Duration(seconds: 30);

  /// Количество повторов при временной ошибке (5xx/сеть/таймаут).
  static const int maxRetries = 2;

  /// Минимальный интервал между запросами генерации (клиентский rate limit).
  static const Duration minRequestInterval = Duration(seconds: 3);
}
