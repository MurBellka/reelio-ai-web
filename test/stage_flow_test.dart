import 'package:flutter_test/flutter_test.dart';
import 'package:reelio_ai/models/enums.dart';

void main() {
  group('Переходы между основными этапами', () {
    test('порядок этапов от старта до экспорта', () {
      expect(AppStage.values, [
        AppStage.onboarding,
        AppStage.upload,
        AppStage.settings,
        AppStage.processing,
        AppStage.preview,
        AppStage.editor,
        AppStage.export,
      ]);
    });

    test('next продвигает по пайплайну', () {
      expect(AppStage.onboarding.next, AppStage.upload);
      expect(AppStage.upload.next, AppStage.settings);
      expect(AppStage.settings.next, AppStage.processing);
      expect(AppStage.processing.next, AppStage.preview);
      expect(AppStage.export.next, isNull);
    });

    test('previous возвращает назад', () {
      expect(AppStage.export.previous, AppStage.editor);
      expect(AppStage.upload.previous, AppStage.onboarding);
      expect(AppStage.onboarding.previous, isNull);
    });

    test('сохранение и восстановление этапа', () {
      for (final stage in AppStage.values) {
        expect(AppStage.fromStorage(stage.storageValue), stage);
      }
    });
  });
}
