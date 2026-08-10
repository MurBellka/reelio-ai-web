// Звук без музыки (контракт v2 §1). Фоновая музыка удалена из продукта
// целиком; остаётся один переключатель — сохранять ли оригинальный звук.
// Тесты закрепляют это на уровне моделей и контроллера состояния, чтобы
// музыка не вернулась незаметно.

import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:reelio_ai/models/edit_plan.dart';
import 'package:reelio_ai/models/transition.dart';
import 'package:reelio_ai/models/enums.dart';
import 'package:reelio_ai/state/providers.dart';
import 'package:shared_preferences/shared_preferences.dart';

EditPlan _plan({AudioSettings audio = AudioSettings.defaults}) => EditPlan(
  id: 'plan_1',
  prompt: 'тест',
  style: EditStyle.dynamicStyle,
  durationSeconds: 8,
  captions: CaptionSettings.defaults,
  audio: audio,
  clips: const [
    EditClip(
      id: 'c1',
      filePath: '/a.mp4',
      type: MediaType.video,
      duration: 8,
      transition: TransitionSpec(type: TransitionType.cut),
      mediaId: 'a',
      start: 0,
      end: 8,
    ),
  ],
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('AudioSettings', () {
    test('по умолчанию оригинальный звук сохраняется', () {
      expect(AudioSettings.defaults.keepOriginal, isTrue);
      expect(const AudioSettings().keepOriginal, isTrue);
    });

    test('copyWith меняет только переключатель', () {
      expect(
        const AudioSettings(
          keepOriginal: true,
        ).copyWith(keepOriginal: false).keepOriginal,
        isFalse,
      );
    });

    test('JSON: круговой рейс сохраняет значение', () {
      for (final keep in [true, false]) {
        final json = AudioSettings(keepOriginal: keep).toJson();
        expect(json, {'keepOriginal': keep});
        expect(AudioSettings.fromJson(json).keepOriginal, keep);
      }
    });

    test('fromJson терпим к отсутствию секции — оригинальный звук', () {
      expect(AudioSettings.fromJson(null).keepOriginal, isTrue);
      expect(AudioSettings.fromJson(const {}).keepOriginal, isTrue);
    });
  });

  group('EditPlan и звук', () {
    test('план сериализует audio и не пишет music', () {
      final json = _plan(
        audio: const AudioSettings(keepOriginal: false),
      ).toJson();
      expect(json.containsKey('music'), isFalse);
      expect(json['audio'], {'keepOriginal': false});
    });

    test('круговой рейс плана сохраняет звук', () {
      final restored = EditPlan.fromJson(
        _plan(audio: const AudioSettings(keepOriginal: false)).toJson(),
      );
      expect(restored.audio.keepOriginal, isFalse);
    });

    test('старый черновик с music, но без audio → оригинальный звук', () {
      // Так выглядит план, сохранённый до v2: секции audio нет, есть
      // устаревшее music. Музыка игнорируется, звук по умолчанию сохраняется.
      final json = _plan().toJson()
        ..remove('audio')
        ..['music'] = {'track': 'energy', 'volume': 0.6};
      final restored = EditPlan.fromJson(json);
      expect(restored.audio.keepOriginal, isTrue);
    });
  });

  group('ProjectController.setKeepOriginalSound', () {
    setUp(() => SharedPreferences.setMockInitialValues({}));

    test('обновляет и настройки проекта, и уже собранный план', () {
      final container = ProviderContainer();
      addTearDown(container.dispose);
      final controller = container.read(projectProvider.notifier);

      expect(container.read(projectProvider).audio.keepOriginal, isTrue);

      controller.setPlan(_plan());
      controller.setKeepOriginalSound(false);

      final state = container.read(projectProvider);
      expect(state.audio.keepOriginal, isFalse);
      expect(state.plan!.audio.keepOriginal, isFalse);

      controller.setKeepOriginalSound(true);
      final state2 = container.read(projectProvider);
      expect(state2.audio.keepOriginal, isTrue);
      expect(state2.plan!.audio.keepOriginal, isTrue);
    });

    test('работает без плана — только настройки проекта', () {
      final container = ProviderContainer();
      addTearDown(container.dispose);
      container.read(projectProvider.notifier).setKeepOriginalSound(false);
      final state = container.read(projectProvider);
      expect(state.audio.keepOriginal, isFalse);
      expect(state.plan, isNull);
    });
  });
}
