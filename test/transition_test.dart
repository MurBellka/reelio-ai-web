// Каталог переходов v2 (§2.1) и его правки в редакторе. Клип хранит переход
// строкой каталога; устаревшие формы v1 принимаются, но пользователю не
// показываются дважды.

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:reelio_ai/features/editor/editor_screen.dart';
import 'package:reelio_ai/models/edit_plan.dart';
import 'package:reelio_ai/models/enums.dart';
import 'package:reelio_ai/models/transition.dart';
import 'package:reelio_ai/state/providers.dart';
import 'package:shared_preferences/shared_preferences.dart';

EditPlan _plan() => const EditPlan(
  id: 'plan_1',
  prompt: 'тест',
  style: EditStyle.dynamicStyle,
  durationSeconds: 12,
  captions: CaptionSettings.defaults,
  audio: AudioSettings.defaults,
  coverClipId: 'c1',
  clips: [
    EditClip(
      id: 'c1',
      filePath: '/a.mp4',
      type: MediaType.video,
      duration: 6,
      transition: 'cut',
      mediaId: 'a',
      sourceName: 'a.mp4',
      start: 0,
      end: 6,
    ),
    EditClip(
      id: 'c2',
      filePath: '/b.mp4',
      type: MediaType.video,
      duration: 6,
      transition: 'crossfade',
      mediaId: 'b',
      sourceName: 'b.mp4',
      start: 0,
      end: 6,
    ),
  ],
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('Каталог TransitionType', () {
    test('storageValue у каждого типа уникален', () {
      final values = TransitionType.values.map((t) => t.storageValue).toList();
      expect(values.toSet().length, values.length);
    });

    test('каталог покрывает все смысловые группы', () {
      final byGroup = TransitionType.byGroup;
      expect(byGroup.keys.toSet(), TransitionGroup.values.toSet());
      // Каждая группа непуста, суммарно — весь каталог.
      final total = byGroup.values.fold<int>(0, (s, l) => s + l.length);
      expect(total, TransitionType.values.length);
      for (final list in byGroup.values) {
        expect(list, isNotEmpty);
      }
    });

    test('fromStorage распознаёт прямые типы', () {
      expect(TransitionType.fromStorage('dissolve'), TransitionType.dissolve);
      expect(TransitionType.fromStorage('wipeLeft'), TransitionType.wipeLeft);
      expect(TransitionType.fromStorage('zoomIn'), TransitionType.zoomIn);
    });

    test('устаревшие формы v1 переходят по §7', () {
      // crossfade — синоним dissolve; fade → в чёрное; slide → сдвиг влево.
      expect(TransitionType.fromStorage('crossfade'), TransitionType.dissolve);
      expect(TransitionType.fromStorage('fade'), TransitionType.fadeBlack);
      expect(TransitionType.fromStorage('slide'), TransitionType.slideLeft);
    });

    test('неизвестное и null → запасной переход', () {
      expect(TransitionType.fromStorage('zoom-blast'), TransitionType.fallback);
      expect(TransitionType.fromStorage(null), TransitionType.fallback);
    });

    test('isKnownStorage — каталог плюс синонимы, но не мусор', () {
      expect(TransitionType.isKnownStorage('slideUp'), isTrue);
      expect(TransitionType.isKnownStorage('crossfade'), isTrue);
      expect(TransitionType.isKnownStorage('fade'), isTrue);
      expect(TransitionType.isKnownStorage('zoom-blast'), isFalse);
      expect(TransitionType.isKnownStorage(null), isFalse);
    });

    test('crossfade не показывается в каталоге отдельным элементом', () {
      final stored = TransitionType.values.map((t) => t.storageValue);
      expect(stored, contains('dissolve'));
      expect(stored, isNot(contains('crossfade')));
    });
  });

  group('ProjectController.setClipTransition', () {
    setUp(() => SharedPreferences.setMockInitialValues({}));

    ProjectController controllerWithPlan() {
      final container = ProviderContainer();
      addTearDown(container.dispose);
      final controller = container.read(projectProvider.notifier);
      controller.setPlan(_plan());
      return controller;
    }

    test('меняет переход выбранного клипа', () {
      final controller = controllerWithPlan();
      controller.setClipTransition(1, TransitionType.wipeUp);
      final clips = controller.state.plan!.clips;
      expect(clips[1].transition, 'wipeUp');
      // Соседний клип не тронут.
      expect(clips[0].transition, 'cut');
    });

    test('индекс вне диапазона — без изменений', () {
      final controller = controllerWithPlan();
      controller.setClipTransition(9, TransitionType.blur);
      controller.setClipTransition(-1, TransitionType.blur);
      expect(controller.state.plan!.clips[0].transition, 'cut');
      expect(controller.state.plan!.clips[1].transition, 'crossfade');
    });
  });

  group('Редактор: выбор перехода', () {
    setUp(() => SharedPreferences.setMockInitialValues({}));

    testWidgets('тап по чипу открывает каталог и меняет переход', (
      tester,
    ) async {
      await tester.binding.setSurfaceSize(const Size(390, 844));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      final container = ProviderContainer();
      addTearDown(container.dispose);
      container.read(projectProvider.notifier).setPlan(_plan());

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(home: EditorScreen()),
        ),
      );
      await tester.pumpAndSettle();

      // Первый клип — «Встык» (cut).
      expect(find.text('Встык'), findsOneWidget);

      await tester.tap(find.text('Встык'));
      await tester.pumpAndSettle();

      // Открылся каталог с разделами.
      expect(find.text('Переход'), findsOneWidget);
      expect(find.text('Затемнения'), findsOneWidget);

      // «В чёрное» нет в таймлайне, поэтому тап однозначен.
      await tester.tap(find.text('В чёрное'));
      await tester.pumpAndSettle();

      expect(
        container.read(projectProvider).plan!.clips[0].transition,
        'fadeBlack',
      );
    });
  });
}
