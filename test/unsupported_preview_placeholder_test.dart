import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:reelio_ai/models/enums.dart';
import 'package:reelio_ai/models/media_asset.dart';
import 'package:reelio_ai/shared/unsupported_preview_placeholder.dart';

void main() {
  group('UnsupportedPreviewPlaceholder', () {
    testWidgets(
      'показывает имя, формат и сообщение вместо падения приложения',
      (tester) async {
        await tester.pumpWidget(
          const MaterialApp(
            home: Scaffold(
              body: UnsupportedPreviewPlaceholder(
                name: 'отпуск.avi',
                format: 'AVI',
              ),
            ),
          ),
        );

        expect(find.text('отпуск.avi'), findsOneWidget);
        expect(find.text('AVI'), findsOneWidget);
        expect(
          find.text('Предпросмотр будет доступен после обработки'),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets('компактный режим не падает и не показывает текст', (
      tester,
    ) async {
      await tester.pumpWidget(
        const MaterialApp(
          home: Scaffold(
            body: SizedBox(
              width: 60,
              height: 60,
              child: UnsupportedPreviewPlaceholder(
                name: 'клип.mkv',
                format: 'MKV',
                compact: true,
              ),
            ),
          ),
        ),
      );

      expect(find.text('MKV'), findsOneWidget);
      expect(find.text('клип.mkv'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('forAsset безопасно работает для видео без длительности', (
      tester,
    ) async {
      const asset = MediaAsset(
        id: 'x',
        path: 'blob:http://localhost/unknown-ext-file',
        name: 'movie.mkv',
        type: MediaType.video,
      );

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: UnsupportedPreviewPlaceholder.forAsset(asset)),
        ),
      );

      expect(find.text('MKV'), findsOneWidget);
      expect(find.text('movie.mkv'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('forAsset не падает, если расширение отсутствует', (
      tester,
    ) async {
      const asset = MediaAsset(
        id: 'y',
        path: 'blob:http://localhost/no-extension',
        name: 'noext',
        type: MediaType.photo,
      );

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(body: UnsupportedPreviewPlaceholder.forAsset(asset)),
        ),
      );

      expect(find.text('—'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });
}
