import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:reelio_ai/app/app.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('Стартовый экран отображает заголовок и кнопку', (tester) async {
    SharedPreferences.setMockInitialValues({});

    await tester.pumpWidget(const ProviderScope(child: ReelioApp()));
    await tester.pumpAndSettle();

    expect(find.textContaining('Преврати моменты'), findsOneWidget);
    expect(find.text('Создать ролик'), findsOneWidget);
    expect(find.text('AI выбирает лучшие моменты'), findsOneWidget);
    expect(find.text('Автоматические субтитры'), findsOneWidget);
  });

  testWidgets('Без черновика ссылка «Продолжить черновик» скрыта', (
    tester,
  ) async {
    SharedPreferences.setMockInitialValues({});

    await tester.pumpWidget(const ProviderScope(child: ReelioApp()));
    await tester.pumpAndSettle();

    expect(find.text('Продолжить черновик'), findsNothing);
  });
}
