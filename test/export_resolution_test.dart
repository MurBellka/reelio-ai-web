import 'package:flutter_test/flutter_test.dart';
import 'package:reelio_ai/models/enums.dart';
import 'package:reelio_ai/models/export_settings.dart';

void main() {
  group('Выбор конкретного разрешения', () {
    test('720p', () {
      final s = ExportResolver.build(
        choice: ExportResolution.hd720,
        durationSeconds: 30,
        sourceMaxHeight: 4000,
      );
      expect(s.width, 720);
      expect(s.height, 1280);
      expect(s.fps, 30);
      expect(s.isUpscale, isFalse);
    });

    test('1080p', () {
      final s = ExportResolver.build(
        choice: ExportResolution.fullHd1080,
        durationSeconds: 30,
        sourceMaxHeight: 4000,
      );
      expect(s.width, 1080);
      expect(s.height, 1920);
    });

    test('2K', () {
      final s = ExportResolver.build(
        choice: ExportResolution.twoK1440,
        durationSeconds: 30,
        sourceMaxHeight: 4000,
      );
      expect(s.width, 1440);
      expect(s.height, 2560);
    });

    test('4K', () {
      final s = ExportResolver.build(
        choice: ExportResolution.fourK2160,
        durationSeconds: 30,
        sourceMaxHeight: 4000,
      );
      expect(s.width, 2160);
      expect(s.height, 3840);
    });
  });

  group('Максимальное доступное качество', () {
    test('подбирает наибольшее не выше исходника (1920 → 1080p)', () {
      final s = ExportResolver.build(
        choice: ExportResolution.maximumAvailable,
        durationSeconds: 30,
        sourceMaxHeight: 1920,
      );
      expect(s.resolution, ExportResolution.maximumAvailable);
      expect(s.height, 1920);
      expect(s.isUpscale, isFalse);
    });

    test('источник 2560 → 2K', () {
      final s = ExportResolver.build(
        choice: ExportResolution.maximumAvailable,
        durationSeconds: 30,
        sourceMaxHeight: 2560,
      );
      expect(s.height, 2560);
    });

    test('неизвестный источник → 1080p по умолчанию', () {
      final s = ExportResolver.build(
        choice: ExportResolution.maximumAvailable,
        durationSeconds: 30,
        sourceMaxHeight: null,
      );
      expect(s.height, 1920);
    });
  });

  group('Предупреждение об апскейле', () {
    test('4K при источнике 1080 → upscale', () {
      final s = ExportResolver.build(
        choice: ExportResolution.fourK2160,
        durationSeconds: 30,
        sourceMaxHeight: 1920,
      );
      expect(s.isUpscale, isTrue);
    });

    test('maximumAvailable никогда не апскейлит', () {
      final s = ExportResolver.build(
        choice: ExportResolution.maximumAvailable,
        durationSeconds: 30,
        sourceMaxHeight: 720,
      );
      expect(s.isUpscale, isFalse);
    });
  });

  group('Оценка размера', () {
    test('больше разрешение → больше размер', () {
      final hd = ExportResolver.estimateSizeBytes(
        height: 1280,
        durationSeconds: 30,
      );
      final uhd = ExportResolver.estimateSizeBytes(
        height: 3840,
        durationSeconds: 30,
      );
      expect(uhd, greaterThan(hd));
      expect(hd, greaterThan(0));
    });
  });

  test('ExportSettings сериализуется без потерь', () {
    final s = ExportResolver.build(
      choice: ExportResolution.twoK1440,
      durationSeconds: 45,
      sourceMaxHeight: 3000,
    );
    final restored = ExportSettings.fromJson(s.toJson());
    expect(restored.resolution, s.resolution);
    expect(restored.width, s.width);
    expect(restored.height, s.height);
    expect(restored.estimatedSizeBytes, s.estimatedSizeBytes);
  });
}
