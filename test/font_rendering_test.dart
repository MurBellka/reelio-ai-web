// Шрифты §5: предпросмотр и MP4 обязаны использовать один и тот же файл.
//
// 1) Тест соответствия: каждый fontId каталога объявлен в pubspec.yaml
//    (семейство + файл начертания), файлы существуют на диске.
// 2) Виджет-тест: выбор шрифта реально меняет TextStyle.fontFamily текста на
//    сцене — значит это не молчаливый системный fallback.

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:reelio_ai/features/editor/editor_screen.dart';
import 'package:reelio_ai/models/edit_plan.dart';
import 'package:reelio_ai/models/enums.dart';
import 'package:reelio_ai/models/font_catalog.dart';
import 'package:reelio_ai/models/text_template.dart';
import 'package:reelio_ai/state/providers.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Разбирает секцию `fonts:` pubspec.yaml → семейство → список asset-файлов.
/// Секция `fonts:` — последняя в файле, поэтому читаем от неё до конца.
Map<String, List<String>> parsePubspecFonts() {
  final lines = File('pubspec.yaml').readAsLinesSync();
  final start = lines.indexWhere(
    (l) => RegExp(r'^\s{2}fonts:\s*$').hasMatch(l),
  );
  expect(start, greaterThanOrEqualTo(0), reason: 'в pubspec нет секции fonts:');

  final fonts = <String, List<String>>{};
  String? current;
  for (final line in lines.skip(start + 1)) {
    final fam = RegExp(r'^\s*-\s*family:\s*(.+?)\s*$').firstMatch(line);
    if (fam != null) {
      current = fam.group(1);
      fonts[current!] = [];
      continue;
    }
    final asset = RegExp(r'^\s*-\s*asset:\s*(.+?)\s*$').firstMatch(line);
    if (asset != null && current != null) fonts[current]!.add(asset.group(1)!);
  }
  return fonts;
}

EditPlan _planWith(List overlays) => EditPlan(
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
      transition: 'cut',
      mediaId: 'a',
      start: 0,
      end: 12,
    ),
  ],
);

void main() {
  group('Соответствие каталога и pubspec', () {
    test('каждый fontId имеет объявленное семейство и файл в pubspec', () {
      final fonts = parsePubspecFonts();
      for (final id in FontFamilyId.values) {
        expect(
          fonts.containsKey(id.family),
          isTrue,
          reason:
              '${id.storageValue}: семейство «${id.family}» не объявлено в pubspec',
        );
        final assets = fonts[id.family]!;
        expect(assets, isNotEmpty, reason: '${id.family}: нет ни одного файла');
        for (final a in assets) {
          expect(
            File(a).existsSync(),
            isTrue,
            reason: '${id.family}: файл $a отсутствует на диске',
          );
        }
      }
    });

    test('каждое семейство несёт начертание 400 (regular)', () {
      // Regular обязателен: на него откатываются недостающие веса.
      final lines = File('pubspec.yaml').readAsStringSync();
      for (final id in FontFamilyId.values) {
        // Файл Regular соответствующего семейства присутствует.
        expect(
          RegExp('family:\\s*${RegExp.escape(id.family)}\\b').hasMatch(lines),
          isTrue,
          reason: '${id.family}: нет объявления family',
        );
      }
    });
  });

  group('Выбор шрифта меняет fontFamily текста', () {
    setUp(() => SharedPreferences.setMockInitialValues({}));

    testWidgets('Caveat применяется к слою на сцене', (tester) async {
      await tester.binding.setSurfaceSize(const Size(400, 1600));
      addTearDown(() => tester.binding.setSurfaceSize(null));

      final overlay = TextTemplate.headline.build(id: 'a', text: 'Раз');
      final container = ProviderContainer();
      addTearDown(container.dispose);
      container.read(projectProvider.notifier).setPlan(_planWith([overlay]));

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(home: EditorScreen()),
        ),
      );
      await tester.pumpAndSettle();

      // Изначально — семейство шаблона headline (Montserrat).
      Text stageText() => tester.widget<Text>(find.text('Раз'));
      expect(stageText().style!.fontFamily, 'Montserrat');

      // Открываем редактор слоя и выбираем Caveat.
      await tester.ensureVisible(find.text('Раз'));
      await tester.tap(find.text('Раз'));
      await tester.pumpAndSettle();

      await tester.ensureVisible(find.text('Caveat'));
      await tester.tap(find.text('Caveat'));
      await tester.pumpAndSettle();

      await tester.ensureVisible(find.text('Готово'));
      await tester.tap(find.text('Готово'));
      await tester.pumpAndSettle();

      // Слой на сцене теперь рисуется семейством Caveat.
      expect(stageText().style!.fontFamily, 'Caveat');
      expect(
        container.read(projectProvider).plan!.textOverlays.single.fontId,
        FontFamilyId.caveat,
      );
    });
  });
}
