// Текстовый редактор в экране правок: добавление по шаблону, три уровня
// интерфейса, перетаскивание и удаление слоя.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:reelio_ai/features/editor/editor_screen.dart';
import 'package:reelio_ai/models/edit_plan.dart';
import 'package:reelio_ai/models/transition.dart';
import 'package:reelio_ai/models/enums.dart';
import 'package:reelio_ai/models/font_catalog.dart';
import 'package:reelio_ai/models/text_template.dart';
import 'package:reelio_ai/state/providers.dart';
import 'package:shared_preferences/shared_preferences.dart';

EditPlan _plan({List overlays = const []}) => EditPlan(
  id: 'plan_1',
  prompt: 'тест',
  style: EditStyle.dynamicStyle,
  durationSeconds: 12,
  captions: CaptionSettings.defaults,
  audio: AudioSettings.defaults,
  coverClipId: 'c1',
  textOverlays: overlays.cast(),
  clips: const [
    EditClip(
      id: 'c1',
      filePath: '/a.mp4',
      type: MediaType.video,
      duration: 12,
      transition: TransitionSpec(type: TransitionType.cut),
      mediaId: 'a',
      start: 0,
      end: 12,
    ),
  ],
);

Future<ProviderContainer> pumpEditor(WidgetTester tester, EditPlan plan) async {
  // Высокий экран, чтобы содержимое нижних листов (в т. ч. уровень «Про» и
  // кнопка «Готово») помещалось целиком: ленивый ListView не строит то, что
  // за пределами вьюпорта, и find его не находит.
  await tester.binding.setSurfaceSize(const Size(400, 1600));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final container = ProviderContainer();
  addTearDown(container.dispose);
  container.read(projectProvider.notifier).setPlan(plan);
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: const MaterialApp(home: EditorScreen()),
    ),
  );
  await tester.pumpAndSettle();
  return container;
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('добавление текста по шаблону создаёт оформленный слой', (
    tester,
  ) async {
    final container = await pumpEditor(tester, _plan());

    await tester.tap(find.text('Добавить'));
    await tester.pumpAndSettle();

    // Открылся выбор шаблона.
    expect(find.text('Шаблон текста'), findsOneWidget);
    await tester.tap(find.text('Заголовок'));
    await tester.pumpAndSettle();

    // Следом открылся редактор слоя.
    expect(find.text('Надпись'), findsOneWidget);
    await tester.tap(find.text('Готово'));
    await tester.pumpAndSettle();

    final overlays = container.read(projectProvider).plan!.textOverlays;
    expect(overlays, hasLength(1));
    expect(overlays.single.fontId, FontFamilyId.montserrat); // шаблон headline
  });

  testWidgets('уровень «Про» открывает дополнительные элементы', (
    tester,
  ) async {
    final overlay = TextTemplate.minimal.build(id: 'a', text: 'Раз');
    await pumpEditor(tester, _plan(overlays: [overlay]));

    await tester.ensureVisible(find.text('Раз'));
    await tester.tap(find.text('Раз'));
    await tester.pumpAndSettle();

    // На «Стандартном» уровне (по умолчанию) есть шрифт, но нет начертания.
    expect(find.text('Шрифт'), findsOneWidget);
    expect(find.text('Начертание'), findsNothing);

    await tester.tap(find.text('Про'));
    await tester.pumpAndSettle();
    expect(find.text('Начертание'), findsOneWidget);
    expect(find.text('Плашка под текстом'), findsOneWidget);

    // «Простой» прячет даже шрифт.
    await tester.tap(find.text('Простой'));
    await tester.pumpAndSettle();
    expect(find.text('Шрифт'), findsNothing);
    expect(find.text('Начертание'), findsNothing);
  });

  testWidgets('перетаскивание слоя сдвигает его вправо', (tester) async {
    final overlay = TextTemplate.minimal.build(id: 'a', text: 'Раз');
    final container = await pumpEditor(tester, _plan(overlays: [overlay]));
    final startX = container.read(projectProvider).plan!.textOverlays.single.x;

    await tester.ensureVisible(find.text('Раз'));
    await tester.pumpAndSettle();
    // Перетаскивание пальцем несколькими шагами, чтобы уверенно пройти
    // порог распознавания жеста (touch slop).
    final gesture = await tester.startGesture(
      tester.getCenter(find.text('Раз')),
    );
    await tester.pump(const Duration(milliseconds: 20));
    await gesture.moveBy(const Offset(40, 0));
    await tester.pump();
    await gesture.moveBy(const Offset(40, 0));
    await tester.pump();
    await gesture.up();
    await tester.pumpAndSettle();

    final endX = container.read(projectProvider).plan!.textOverlays.single.x;
    expect(endX, greaterThan(startX));
  });

  testWidgets('удаление слоя из редактора убирает его со сцены', (
    tester,
  ) async {
    final overlay = TextTemplate.headline.build(id: 'a', text: 'Раз');
    final container = await pumpEditor(tester, _plan(overlays: [overlay]));

    await tester.ensureVisible(find.text('Раз'));
    await tester.tap(find.text('Раз'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Удалить'));
    await tester.pumpAndSettle();

    expect(container.read(projectProvider).plan!.textOverlays, isEmpty);
  });
}
