// Проверка поколения API перед отправкой материалов.
//
// Старый и новый backend несовместимы по авторизации. Без этой проверки
// пользователь выгрузил бы файлы и получил отказ уже после — потратив трафик.

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:reelio_ai/services/backend_version_service.dart';

void main() {
  BackendVersionService serviceReturning(Object? body, {int status = 200}) {
    final client = MockClient((_) async {
      if (body == null) return http.Response('', status);
      return http.Response(
        jsonEncode(body),
        status,
        headers: {'content-type': 'application/json'},
      );
    });
    return BackendVersionService(
      client: client,
      baseUrl: 'https://api.example.com',
    );
  }

  group('готовность backend', () {
    test('новая версия разрешает отправку', () async {
      final s = serviceReturning({
        'ok': true,
        'apiVersion': 2,
        'authRequired': true,
      });
      final status = await s.check();

      expect(status.readiness, BackendReadiness.ready);
      expect(status.canSubmitWork, isTrue);
      expect(status.apiVersion, 2);
      expect(status.authRequired, isTrue);
    });

    test('ответ без apiVersion — это старый backend', () async {
      // Ключевой случай выката: старая версия отвечает валидно, просто не
      // сообщает поколение. Отправлять материалы туда нельзя.
      final s = serviceReturning({'ok': true, 'service': 'reelio-backend'});
      final status = await s.check();

      expect(status.readiness, BackendReadiness.updating);
      expect(status.canSubmitWork, isFalse);
      expect(status.apiVersion, isNull);
    });

    test('версия ниже требуемой тоже блокирует', () async {
      final s = serviceReturning({'ok': true, 'apiVersion': 1});
      final status = await s.check();

      expect(status.readiness, BackendReadiness.updating);
      expect(status.canSubmitWork, isFalse);
    });

    test('5xx означает недоступность, а не устаревание', () async {
      // Различие важно для текста ошибки: «обновляем» и «нет связи» требуют
      // разных действий от пользователя.
      final s = serviceReturning({'error': 'boom'}, status: 503);
      final status = await s.check();

      expect(status.readiness, BackendReadiness.unreachable);
      expect(status.canSubmitWork, isFalse);
    });

    test('неразборчивый ответ считается недоступностью', () async {
      final client = MockClient(
        (_) async => http.Response('<html>прокси</html>', 200),
      );
      final s = BackendVersionService(
        client: client,
        baseUrl: 'https://api.example.com',
      );

      expect((await s.check()).readiness, BackendReadiness.unreachable);
    });

    test('без адреса backend запрос не уходит', () async {
      var called = false;
      final client = MockClient((_) async {
        called = true;
        return http.Response('{}', 200);
      });
      final s = BackendVersionService(client: client, baseUrl: '');

      expect((await s.check()).readiness, BackendReadiness.unreachable);
      expect(called, isFalse);
    });
  });

  group('кэш проверки', () {
    test('повторный вызов не бьёт по сети', () async {
      var calls = 0;
      final client = MockClient((_) async {
        calls++;
        return http.Response(
          '{"ok":true,"apiVersion":2}',
          200,
          headers: {'content-type': 'application/json'},
        );
      });
      final s = BackendVersionService(
        client: client,
        baseUrl: 'https://api.example.com',
      );

      await s.check();
      await s.check();
      await s.check();

      expect(calls, 1, reason: 'проверка идёт перед каждой отправкой');
    });

    test('force обновляет результат — нужен после переключения', () async {
      var calls = 0;
      final client = MockClient((_) async {
        calls++;
        // Первый ответ — старый backend, второй — уже новый.
        final body = calls == 1
            ? '{"ok":true}'
            : '{"ok":true,"apiVersion":2,"authRequired":true}';
        return http.Response(
          body,
          200,
          headers: {'content-type': 'application/json'},
        );
      });
      final s = BackendVersionService(
        client: client,
        baseUrl: 'https://api.example.com',
      );

      expect((await s.check()).readiness, BackendReadiness.updating);
      final after = await s.check(force: true);

      expect(after.readiness, BackendReadiness.ready);
      expect(calls, 2);
    });
  });
}
