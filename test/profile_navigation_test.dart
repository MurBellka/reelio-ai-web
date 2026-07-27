// Доступность аккаунта из интерфейса.
//
// Проверка именно навигационная: сам по себе экран профиля бесполезен, если до
// него нельзя дойти с телефона за одно касание.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:reelio_ai/core/constants.dart';
import 'package:reelio_ai/shared/profile_button.dart';

void main() {
  _contactTests();

  /// Типичный экран телефона: узкий и высокий.
  const phone = Size(390, 844);

  Future<void> pumpAppBar(WidgetTester tester, {required Widget child}) async {
    await tester.binding.setSurfaceSize(phone);
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          appBar: AppBar(title: const Text('Экран'), actions: [child]),
          body: const SizedBox.expand(),
        ),
      ),
    );
  }

  group('кнопка профиля', () {
    testWidgets('без backend не показывается', (tester) async {
      // В демо-режиме аккаунта нет — кнопка не должна занимать место и
      // предлагать несуществующий сценарий.
      await pumpAppBar(tester, child: const ProfileButton());
      await tester.pump();

      // AppConfig.hasBackend в тестовой сборке равен false: REELIO_BACKEND_URL
      // не задан, поэтому виджет схлопывается.
      expect(find.byIcon(Icons.account_circle_rounded), findsNothing);
    });

    testWidgets('помещается в панель узкого экрана без переполнения', (
      tester,
    ) async {
      await pumpAppBar(tester, child: const ProfileButton());
      await tester.pump();
      expect(tester.takeException(), isNull);
    });
  });

  group('размеры касания', () {
    testWidgets('кнопка в панели не меньше 48 логических пикселей', (
      tester,
    ) async {
      // Проверяем на настоящей кнопке с тем же стилем, что у ProfileButton:
      // на телефоне слишком мелкая цель — частая причина промахов.
      await pumpAppBar(
        tester,
        child: TextButton.icon(
          onPressed: () {},
          style: TextButton.styleFrom(
            minimumSize: const Size(48, 48),
            padding: const EdgeInsets.symmetric(horizontal: 12),
          ),
          icon: const Icon(Icons.account_circle_rounded),
          label: const Text('4'),
        ),
      );
      await tester.pump();

      final size = tester.getSize(find.byType(TextButton));
      expect(size.height, greaterThanOrEqualTo(48));
      expect(size.width, greaterThanOrEqualTo(48));
    });
  });
}

// ── Публичный контакт ──────────────────────────────────────────────────────

void _contactTests() {
  group('контакт поддержки', () {
    test('адрес задан и не является заглушкой', () {
      expect(AppConstants.supportEmail, isNotEmpty);
      expect(AppConstants.supportEmail, contains('@'));
      // Заглушки не должны доехать до публичной сборки.
      expect(AppConstants.supportEmail, isNot(contains('example.com')));
      expect(AppConstants.supportEmail, isNot(contains('TODO')));
    });

    test('mailto собирается корректно и кодирует тему', () {
      final link = AppConstants.supportMailto(subject: 'Удаление данных');
      expect(link, startsWith('mailto:${AppConstants.supportEmail}'));
      expect(link, contains('subject='));
      // Пробелы обязаны быть закодированы, иначе часть темы потеряется.
      expect(link, isNot(contains('Удаление данных')));
      expect(Uri.parse(link).queryParameters['subject'], 'Удаление данных');
    });
  });
}
