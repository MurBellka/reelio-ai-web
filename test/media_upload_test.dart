import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:reelio_ai/models/enums.dart';
import 'package:reelio_ai/models/media_asset.dart';
import 'package:reelio_ai/models/upload_ticket.dart';
import 'package:reelio_ai/services/media_upload_service.dart';

const videoAsset = MediaAsset(
  id: 'asset_a',
  path: '/local/a.mp4',
  name: 'a.mp4',
  type: MediaType.video,
);

const photoAsset = MediaAsset(
  id: 'asset_b',
  path: '/local/b.jpg',
  name: 'b.jpg',
  type: MediaType.photo,
);

UploadTicket ticketFor(String assetId, {DateTime? expiresAt}) => UploadTicket(
  assetId: assetId,
  objectPath: 'projects/proj_1/sources/$assetId',
  uploadUrl: 'https://storage.googleapis.com/put/$assetId?sig=1',
  headers: const {'x-goog-content-length-range': '0,1073741824'},
  expiresAt: expiresAt,
);

MediaUploadService serviceWith(
  Future<http.Response> Function(http.Request request) handler, {
  int fileSize = 12,
  Future<Uint8List> Function(String path)? readBytes,
}) => MediaUploadService(
  client: MockClient(handler),
  readBytes:
      readBytes ?? (_) async => Uint8List.fromList(List.filled(fileSize, 7)),
  chunkSize: 4,
);

void main() {
  group('Прямая загрузка по signed URL', () {
    test('загружает материалы и возвращает их размеры', () async {
      final requests = <http.Request>[];
      final service = serviceWith((request) async {
        requests.add(request);
        return http.Response('', 200);
      });

      final sizes = await service.uploadAll(
        assets: const [videoAsset, photoAsset],
        tickets: [ticketFor('asset_a'), ticketFor('asset_b')],
      );

      expect(sizes, {'asset_a': 12, 'asset_b': 12});
      expect(requests, hasLength(2));
      expect(requests.first.method, 'PUT');
      expect(requests.first.url.toString(), contains('put/asset_a'));
      expect(requests.first.headers['Content-Type'], 'video/mp4');
      expect(requests.last.headers['Content-Type'], 'image/jpeg');
      expect(
        requests.first.headers['x-goog-content-length-range'],
        '0,1073741824',
      );
      expect(requests.first.bodyBytes, hasLength(12));
    });

    test('прогресс растёт от нуля до единицы', () async {
      final service = serviceWith((_) async => http.Response('', 200));
      final seen = <double>[];

      await service.uploadAll(
        assets: const [videoAsset, photoAsset],
        tickets: [ticketFor('asset_a'), ticketFor('asset_b')],
        onProgress: (progress) => seen.add(progress.fraction),
      );

      expect(seen.first, 0);
      expect(seen.last, 1);
      expect(seen, isNot(hasLength(lessThan(3))));
      for (var i = 1; i < seen.length; i++) {
        expect(seen[i], greaterThanOrEqualTo(seen[i - 1]));
      }
    });

    test('подпись прогресса называет файл и его номер', () async {
      final service = serviceWith((_) async => http.Response('', 200));
      final labels = <String>[];

      await service.uploadAll(
        assets: const [videoAsset, photoAsset],
        tickets: [ticketFor('asset_a'), ticketFor('asset_b')],
        onProgress: (progress) {
          if (progress.currentFileName.isNotEmpty) {
            labels.add('${progress.label} ${progress.currentFileName}');
          }
        },
      );

      expect(labels, contains('Загрузка 1 из 2 a.mp4'));
      expect(labels, contains('Загрузка 2 из 2 b.jpg'));
    });

    test('загружаются только материалы с разрешением', () async {
      var calls = 0;
      final service = serviceWith((_) async {
        calls++;
        return http.Response('', 200);
      });

      final sizes = await service.uploadAll(
        assets: const [videoAsset, photoAsset],
        tickets: [ticketFor('asset_a')],
      );

      expect(calls, 1);
      expect(sizes.keys, ['asset_a']);
    });
  });

  group('Ошибки загрузки', () {
    test('отмена прерывает загрузку', () async {
      final service = serviceWith((_) async => http.Response('', 200));

      await expectLater(
        service.uploadAll(
          assets: const [videoAsset],
          tickets: [ticketFor('asset_a')],
          isCancelled: () => true,
        ),
        throwsA(isA<MediaUploadCancelled>()),
      );
    });

    test('истёкшее разрешение не используется', () async {
      final service = serviceWith((_) async => fail('запрос не должен уйти'));

      await expectLater(
        service.uploadAll(
          assets: const [videoAsset],
          tickets: [ticketFor('asset_a', expiresAt: DateTime.utc(2000))],
        ),
        throwsA(
          isA<MediaUploadException>().having(
            (e) => e.message,
            'message',
            contains('истёк'),
          ),
        ),
      );
    });

    test('403 от хранилища трактуется как протухшая ссылка', () async {
      final service = serviceWith((_) async => http.Response('denied', 403));

      await expectLater(
        service.uploadAll(
          assets: const [videoAsset],
          tickets: [ticketFor('asset_a')],
        ),
        throwsA(
          isA<MediaUploadException>()
              .having((e) => e.retryable, 'retryable', isTrue)
              .having((e) => e.message, 'message', contains('истекла')),
        ),
      );
    });

    test('5xx от хранилища допускает повтор', () async {
      final service = serviceWith((_) async => http.Response('oops', 503));

      await expectLater(
        service.uploadAll(
          assets: const [videoAsset],
          tickets: [ticketFor('asset_a')],
        ),
        throwsA(
          isA<MediaUploadException>().having(
            (e) => e.retryable,
            'retryable',
            isTrue,
          ),
        ),
      );
    });

    test('нечитаемый файл — ошибка без повтора', () async {
      final service = serviceWith(
        (_) async => fail('запрос не должен уйти'),
        readBytes: (_) async => throw StateError('файл исчез'),
      );

      await expectLater(
        service.uploadAll(
          assets: const [videoAsset],
          tickets: [ticketFor('asset_a')],
        ),
        throwsA(
          isA<MediaUploadException>()
              .having((e) => e.retryable, 'retryable', isFalse)
              .having((e) => e.message, 'message', contains('a.mp4')),
        ),
      );
    });
  });

  group('MIME-типы материалов', () {
    test('видео и фото получают корректный Content-Type', () {
      expect(MediaUploadService.contentTypeFor(videoAsset), 'video/mp4');
      expect(MediaUploadService.contentTypeFor(photoAsset), 'image/jpeg');
      expect(
        MediaUploadService.contentTypeFor(
          const MediaAsset(
            id: 'c',
            path: '/local/c.MOV',
            name: 'c.MOV',
            type: MediaType.video,
          ),
        ),
        'video/quicktime',
      );
      expect(
        MediaUploadService.contentTypeFor(
          const MediaAsset(
            id: 'd',
            path: '/local/d.heic',
            name: 'd.heic',
            type: MediaType.photo,
          ),
        ),
        'image/heic',
      );
    });

    test('неизвестное расширение сводится к типу материала', () {
      expect(
        MediaUploadService.contentTypeFor(
          const MediaAsset(
            id: 'e',
            path: '/local/e',
            name: 'e',
            type: MediaType.photo,
          ),
        ),
        'image/jpeg',
      );
    });
  });

  group('UploadProgress', () {
    test('доля считается по файлам и текущему прогрессу', () {
      const progress = UploadProgress(
        completedFiles: 1,
        totalFiles: 4,
        currentFileFraction: 0.5,
      );
      expect(progress.fraction, closeTo(0.375, 1e-9));
      expect(progress.isDone, isFalse);
    });

    test('пустой прогресс безопасен', () {
      expect(UploadProgress.empty.fraction, 0);
      expect(UploadProgress.empty.isEmpty, isTrue);
      expect(UploadProgress.empty.isDone, isFalse);
    });
  });
}
