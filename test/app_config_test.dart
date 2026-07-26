import 'package:flutter_test/flutter_test.dart';
import 'package:reelio_ai/core/app_config.dart';
import 'package:reelio_ai/core/formatters.dart';

void main() {
  group('Клиентская конфигурация не содержит ключей', () {
    test('по умолчанию (без --dart-define) — Demo Mode, backend не задан', () {
      // В сборке клиента нет и не может быть GEMINI_API_KEY: клиент знает
      // только про URL backend'а (не секрет). Без него — демо-режим.
      expect(AppConfig.backendBaseUrl, isEmpty);
      expect(AppConfig.hasBackend, isFalse);
      expect(AppConfig.isDemoMode, isTrue);
    });
  });

  group('Имя файла экспорта JSON', () {
    test('формат reelio-edit-plan-YYYY-MM-DD.json', () {
      final name = Formatters.editPlanFileName(DateTime(2026, 7, 6));
      expect(name, 'reelio-edit-plan-2026-07-06.json');
      expect(name.endsWith('.json'), isTrue);
    });
  });
}
