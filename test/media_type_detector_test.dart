import 'package:flutter_test/flutter_test.dart';
import 'package:reelio_ai/core/media_type_detector.dart';
import 'package:reelio_ai/models/enums.dart';

void main() {
  group('MediaTypeDetector', () {
    test('файл с пустым MIME определяется по расширению видео', () {
      final type = MediaTypeDetector.detect(name: 'clip.mp4', mimeType: '');
      expect(type, MediaType.video);
    });

    test('файл с null MIME определяется по расширению фото', () {
      final type = MediaTypeDetector.detect(name: 'photo.jpg', mimeType: null);
      expect(type, MediaType.photo);
    });

    test('расширение в верхнем регистре распознаётся как видео (.MP4)', () {
      final type = MediaTypeDetector.detect(name: 'clip.MP4', mimeType: null);
      expect(type, MediaType.video);
    });

    test('расширение в верхнем регистре распознаётся как фото (.JPG)', () {
      final type = MediaTypeDetector.detect(name: 'photo.JPG', mimeType: null);
      expect(type, MediaType.photo);
    });

    test(
      'при неизвестном расширении и пустом MIME не падает, а считает фото',
      () {
        expect(
          () => MediaTypeDetector.detect(name: 'mystery', mimeType: ''),
          returnsNormally,
        );
        final type = MediaTypeDetector.detect(name: 'mystery', mimeType: '');
        expect(type, MediaType.photo);
      },
    );

    test('при неизвестном расширении MIME video/* используется как запасной '
        'вариант', () {
      final type = MediaTypeDetector.detect(
        name: 'mystery',
        mimeType: 'video/x-custom',
      );
      expect(type, MediaType.video);
    });
  });
}
