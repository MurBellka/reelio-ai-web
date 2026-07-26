import 'package:flutter_test/flutter_test.dart';
import 'package:reelio_ai/core/constants.dart';
import 'package:reelio_ai/core/media_validation.dart';
import 'package:reelio_ai/models/enums.dart';
import 'package:reelio_ai/models/media_asset.dart';

MediaAsset video(String id, {double duration = 30, String ext = 'mp4'}) =>
    MediaAsset(
      id: id,
      path: '/tmp/$id.$ext',
      name: '$id.$ext',
      type: MediaType.video,
      durationSeconds: duration,
    );

MediaAsset photo(String id, {String ext = 'jpg'}) => MediaAsset(
  id: id,
  path: '/tmp/$id.$ext',
  name: '$id.$ext',
  type: MediaType.photo,
);

void main() {
  group('Лимит количества видео', () {
    test('21-е видео отклоняется', () {
      final existing = [for (var i = 0; i < 20; i++) video('v$i')];
      final result = MediaLimits.validateBatch(
        existing: existing,
        candidates: [video('v21')],
      );
      expect(result.accepted, isEmpty);
      expect(result.rejected, hasLength(1));
      expect(result.rejected.first.reason, contains('лимит видео'));
    });

    test('20 видео принимаются', () {
      final result = MediaLimits.validateBatch(
        existing: const [],
        candidates: [for (var i = 0; i < 20; i++) video('v$i')],
      );
      expect(result.accepted, hasLength(AppConstants.maxVideos));
      expect(result.rejected, isEmpty);
    });
  });

  group('Лимит количества фотографий', () {
    test('21-я фотография отклоняется', () {
      final existing = [for (var i = 0; i < 20; i++) photo('p$i')];
      final result = MediaLimits.validateBatch(
        existing: existing,
        candidates: [photo('p21')],
      );
      expect(result.accepted, isEmpty);
      expect(result.rejected.single.reason, contains('лимит фотографий'));
    });
  });

  group('Длительность видео', () {
    test('видео длиннее 10 минут отклоняется', () {
      final result = MediaLimits.validateBatch(
        existing: const [],
        candidates: [video('long', duration: 10 * 60 + 1)],
      );
      expect(result.accepted, isEmpty);
      expect(result.rejected.single.reason, contains('10 минут'));
    });

    test('видео ровно 10 минут принимается', () {
      final result = MediaLimits.validateBatch(
        existing: const [],
        candidates: [video('ok', duration: 10 * 60)],
      );
      expect(result.accepted, hasLength(1));
    });

    test('видео без длительности принимается с предупреждением, а не '
        'отклоняется', () {
      final result = MediaLimits.validateBatch(
        existing: const [],
        candidates: [
          MediaAsset(
            id: 'x',
            path: '/tmp/x.mp4',
            name: 'x.mp4',
            type: MediaType.video,
            durationSeconds: null,
          ),
        ],
      );
      expect(result.rejected, isEmpty);
      expect(result.accepted, hasLength(1));
      expect(result.hasWarnings, isTrue);
      expect(result.warnings.single.reason, contains('длительность'));
    });
  });

  group('Форматы', () {
    test('неподдерживаемое видео отклоняется', () {
      final result = MediaLimits.validateBatch(
        existing: const [],
        candidates: [video('unsupported', ext: 'wmv')],
      );
      expect(result.rejected.single.reason, contains('MP4'));
    });

    test('неподдерживаемое изображение отклоняется', () {
      final result = MediaLimits.validateBatch(
        existing: const [],
        candidates: [photo('unsupported', ext: 'svg')],
      );
      expect(result.rejected, hasLength(1));
    });

    test('AVI, MKV, MPEG, 3GP и M4V принимаются', () {
      final result = MediaLimits.validateBatch(
        existing: const [],
        candidates: [
          video('a', ext: 'avi'),
          video('b', ext: 'mkv'),
          video('c', ext: 'mpeg'),
          video('d', ext: '3gp'),
          video('e', ext: 'm4v'),
          video('f', ext: 'webm'),
        ],
      );
      expect(result.accepted, hasLength(6));
      expect(result.rejected, isEmpty);
    });

    test('HEIC, HEIF, WebP, GIF, BMP и TIFF принимаются', () {
      final result = MediaLimits.validateBatch(
        existing: const [],
        candidates: [
          photo('a', ext: 'heic'),
          photo('b', ext: 'webp'),
          photo('c', ext: 'heif'),
          photo('d', ext: 'gif'),
          photo('e', ext: 'bmp'),
          photo('f', ext: 'tiff'),
        ],
      );
      expect(result.accepted, hasLength(6));
      expect(result.rejected, isEmpty);
    });
  });

  group('Обязательные форматы', () {
    test('JPG принимается', () {
      final result = MediaLimits.validateBatch(
        existing: const [],
        candidates: [photo('a', ext: 'jpg')],
      );
      expect(result.accepted, hasLength(1));
      expect(result.rejected, isEmpty);
    });

    test('JPEG принимается', () {
      final result = MediaLimits.validateBatch(
        existing: const [],
        candidates: [photo('a', ext: 'jpeg')],
      );
      expect(result.accepted, hasLength(1));
      expect(result.rejected, isEmpty);
    });

    test('MP4 принимается', () {
      final result = MediaLimits.validateBatch(
        existing: const [],
        candidates: [video('a', ext: 'mp4')],
      );
      expect(result.accepted, hasLength(1));
      expect(result.rejected, isEmpty);
    });

    test('MOV принимается', () {
      final result = MediaLimits.validateBatch(
        existing: const [],
        candidates: [video('a', ext: 'mov')],
      );
      expect(result.accepted, hasLength(1));
      expect(result.rejected, isEmpty);
    });
  });

  group('Регистр расширения', () {
    test('.JPG, .JPEG и .MP4 в верхнем регистре принимаются как обычно', () {
      final result = MediaLimits.validateBatch(
        existing: const [],
        candidates: [
          MediaAsset(
            id: 'a',
            path: '/tmp/a.JPG',
            name: 'a.JPG',
            type: MediaType.photo,
          ),
          MediaAsset(
            id: 'b',
            path: '/tmp/b.JPEG',
            name: 'b.JPEG',
            type: MediaType.photo,
          ),
          MediaAsset(
            id: 'c',
            path: '/tmp/c.MP4',
            name: 'c.MP4',
            type: MediaType.video,
            durationSeconds: 12,
          ),
        ],
      );
      expect(result.accepted, hasLength(3));
      expect(result.rejected, isEmpty);
    });
  });

  group('Flutter Web: расширение по имени файла, а не по blob-пути', () {
    test('фото с blob-URL в path определяется по имени файла', () {
      // На вебе XFile.path — это `blob:http://localhost/<uuid>` без
      // расширения. Если бы формат определялся по path, файл всегда
      // отклонялся бы как неподдерживаемый.
      final result = MediaLimits.validateBatch(
        existing: const [],
        candidates: [
          MediaAsset(
            id: 'w1',
            path: 'blob:http://localhost:5000/9f1b7f7e-aaaa-bbbb-cccc',
            name: 'photo.jpg',
            type: MediaType.photo,
          ),
        ],
      );
      expect(result.accepted, hasLength(1));
      expect(result.rejected, isEmpty);
    });

    test('видео с blob-URL в path определяется по имени файла', () {
      final result = MediaLimits.validateBatch(
        existing: const [],
        candidates: [
          MediaAsset(
            id: 'w2',
            path: 'blob:http://localhost:5000/1234-5678-90ab-cdef',
            name: 'clip.mp4',
            type: MediaType.video,
            durationSeconds: 15,
          ),
        ],
      );
      expect(result.accepted, hasLength(1));
      expect(result.rejected, isEmpty);
    });
  });

  group('Дубликаты', () {
    test('повторный путь пропускается без ошибки', () {
      final existing = [video('v0')];
      final result = MediaLimits.validateBatch(
        existing: existing,
        candidates: [video('v0')],
      );
      expect(result.accepted, isEmpty);
      expect(result.rejected, isEmpty);
    });
  });

  group('Итоговая длительность', () {
    test('больше 120 секунд ограничивается 120', () {
      expect(MediaLimits.clampOutputSeconds(200), 120);
      expect(MediaLimits.clampOutputSeconds(120), 120);
      expect(MediaLimits.clampOutputSeconds(30), 30);
      expect(MediaLimits.clampOutputSeconds(0), 1);
    });
  });
}
