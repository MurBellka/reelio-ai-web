import 'package:flutter_test/flutter_test.dart';
import 'package:reelio_ai/core/media_type_detector.dart';
import 'package:reelio_ai/core/media_validation.dart';
import 'package:reelio_ai/models/enums.dart';
import 'package:reelio_ai/models/media_asset.dart';

MediaAsset asset(String name, MediaType type, {double? duration}) => MediaAsset(
  id: name,
  path: 'blob:http://localhost/$name', // web-style path без расширения
  name: name,
  type: type,
  durationSeconds: duration,
);

void main() {
  group('Определение типа по расширению (регистр не важен)', () {
    test('.JPG / .JPEG → фото', () {
      expect(MediaTypeDetector.detect(name: 'IMG.JPG'), MediaType.photo);
      expect(MediaTypeDetector.detect(name: 'Photo.JPEG'), MediaType.photo);
    });

    test('.MP4 / .MOV → видео', () {
      expect(MediaTypeDetector.detect(name: 'Clip.MP4'), MediaType.video);
      expect(MediaTypeDetector.detect(name: 'MOVIE.MOV'), MediaType.video);
    });

    test('пустой MIME + известное расширение', () {
      expect(
        MediaTypeDetector.detect(name: 'a.webm', mimeType: ''),
        MediaType.video,
      );
      expect(
        MediaTypeDetector.detect(name: 'b.png', mimeType: null),
        MediaType.photo,
      );
    });

    test('нет расширения — падаем на MIME', () {
      expect(
        MediaTypeDetector.detect(name: 'noext', mimeType: 'video/mp4'),
        MediaType.video,
      );
    });
  });

  group('Приём файлов с расширением в верхнем регистре', () {
    test('.JPG, .JPEG, .MP4, .MOV принимаются', () {
      final result = MediaLimits.validateBatch(
        existing: const [],
        candidates: [
          asset('A.JPG', MediaType.photo),
          asset('B.JPEG', MediaType.photo),
          asset('C.MP4', MediaType.video, duration: 20),
          asset('D.MOV', MediaType.video, duration: 20),
        ],
      );
      expect(result.accepted, hasLength(4));
      expect(result.rejected, isEmpty);
    });

    test('новые форматы (WebM, MKV, HEIC, TIFF) принимаются', () {
      final result = MediaLimits.validateBatch(
        existing: const [],
        candidates: [
          asset('v.WEBM', MediaType.video, duration: 10),
          asset('v2.MKV', MediaType.video, duration: 10),
          asset('p.HEIC', MediaType.photo),
          asset('p2.TIFF', MediaType.photo),
        ],
      );
      expect(result.accepted, hasLength(4));
    });

    test('видео без длительности принимается с предупреждением', () {
      final result = MediaLimits.validateBatch(
        existing: const [],
        candidates: [asset('x.mkv', MediaType.video)],
      );
      expect(result.accepted, hasLength(1));
      expect(result.hasWarnings, isTrue);
    });
  });
}
