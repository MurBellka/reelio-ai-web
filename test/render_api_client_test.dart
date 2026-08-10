import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:reelio_ai/models/edit_plan.dart';
import 'package:reelio_ai/models/transition.dart';
import 'package:reelio_ai/models/enums.dart';
import 'package:reelio_ai/models/render_job.dart';
import 'package:reelio_ai/models/render_request.dart';
import 'package:reelio_ai/services/render_api_client.dart';

import 'render_job_test.dart' show jobJson, resultJson;

const _base = 'https://api.example.com';

RenderRequest sampleRequest({String? idempotencyKey}) => RenderRequest(
  projectId: 'proj_9d1',
  plan: EditPlan(
    id: 'plan_7f3c',
    prompt: 'ролик',
    style: EditStyle.dynamicStyle,
    durationSeconds: 30,
    captions: CaptionSettings.defaults,
    audio: AudioSettings.defaults,
    clips: const [
      EditClip(
        id: 'clip_1',
        filePath: '/local/a.mp4',
        type: MediaType.video,
        duration: 3,
        start: 0,
        end: 3,
        transition: TransitionSpec(type: TransitionType.cut),
        mediaId: 'asset_a',
      ),
    ],
  ),
  assets: const [
    RenderAsset(
      id: 'asset_a',
      type: MediaType.video,
      objectPath: 'projects/proj_9d1/sources/asset_a.mp4',
    ),
  ],
  idempotencyKey: idempotencyKey,
);

http.Response _json(
  Object body, {
  int status = 200,
  Map<String, String>? headers,
}) => http.Response(
  jsonEncode(body),
  status,
  headers: {'content-type': 'application/json', ...?headers},
);

http.Response _error(
  String code,
  String message, {
  required int status,
  bool retryable = false,
}) => _json({
  'error': {'code': code, 'message': message, 'retryable': retryable},
}, status: status);

RenderApiClient clientWith(
  Future<http.Response> Function(http.Request request) handler, {
  int maxRetries = 2,
}) => RenderApiClient(
  baseUrl: _base,
  client: MockClient(handler),
  maxRetries: maxRetries,
);

void main() {
  group('POST /render', () {
    test('202 создаёт задачу и разбирает состояние', () async {
      late http.Request captured;
      final api = clientWith((request) async {
        captured = request;
        return _json(
          jobJson(status: 'queued', phase: 'queued', progress: 0.01),
          status: 202,
        );
      });

      final job = await api.submitRender(sampleRequest());

      expect(job.jobId, 'job_01J8');
      expect(job.status, RenderStatus.queued);
      expect(captured.method, 'POST');
      expect(captured.url.path, '/render');

      final body = jsonDecode(captured.body) as Map<String, dynamic>;
      expect(body['contractVersion'], kRenderContractVersion);
      expect(body['projectId'], 'proj_9d1');
      expect(captured.headers['X-Reelio-Client'], startsWith('flutter/'));
      expect(captured.headers['Content-Type'], contains('application/json'));
    });

    test('200 возвращает существующую задачу (идемпотентность)', () async {
      final api = clientWith((_) async => _json(jobJson(), status: 200));
      final job = await api.submitRender(sampleRequest());
      expect(job.jobId, 'job_01J8');
    });

    test('Idempotency-Key уходит заголовком', () async {
      late http.Request captured;
      final api = clientWith((request) async {
        captured = request;
        return _json(jobJson(), status: 202);
      });

      await api.submitRender(sampleRequest(idempotencyKey: 'key-1'));
      expect(captured.headers['Idempotency-Key'], 'key-1');
    });

    test('400 PLAN_INVALID не повторяется', () async {
      var calls = 0;
      final api = clientWith((_) async {
        calls++;
        return _error(
          'PLAN_INVALID',
          'Клип ссылается на неизвестный mediaId.',
          status: 400,
        );
      });

      await expectLater(
        api.submitRender(sampleRequest()),
        throwsA(
          isA<RenderApiException>()
              .having((e) => e.code, 'code', 'PLAN_INVALID')
              .having((e) => e.retryable, 'retryable', isFalse)
              .having((e) => e.statusCode, 'statusCode', 400),
        ),
      );
      expect(calls, 1);
    });

    test(
      '503 RENDER_UNAVAILABLE повторяется и проходит со второй попытки',
      () async {
        var calls = 0;
        final api = clientWith((_) async {
          calls++;
          if (calls == 1) {
            return _error(
              'RENDER_UNAVAILABLE',
              'Рендер временно недоступен.',
              status: 503,
              retryable: true,
            );
          }
          return _json(jobJson(), status: 202);
        });

        final job = await api.submitRender(sampleRequest());
        expect(job.jobId, 'job_01J8');
        expect(calls, 2);
      },
    );

    test('исчерпание повторов отдаёт последнюю ошибку', () async {
      var calls = 0;
      final api = clientWith((_) async {
        calls++;
        return _error(
          'INTERNAL',
          'Внутренняя ошибка.',
          status: 500,
          retryable: true,
        );
      });

      await expectLater(
        api.submitRender(sampleRequest()),
        throwsA(
          isA<RenderApiException>().having((e) => e.code, 'code', 'INTERNAL'),
        ),
      );
      expect(calls, 3); // первая попытка + два повтора
    });

    test('сетевой сбой превращается в понятную ошибку', () async {
      final api = clientWith(
        (_) async => throw const SocketExceptionStub(),
        maxRetries: 0,
      );

      await expectLater(
        api.submitRender(sampleRequest()),
        throwsA(
          isA<RenderApiException>()
              .having((e) => e.retryable, 'retryable', isTrue)
              .having((e) => e.message, 'message', contains('связи')),
        ),
      );
    });
  });

  group('GET /jobs/{id}', () {
    test('читает состояние задачи', () async {
      final api = clientWith((request) async {
        expect(request.url.path, '/jobs/job_01J8');
        return _json(jobJson());
      });

      final job = await api.fetchJob('job_01J8');
      expect(job.phase, RenderPhase.encoding);
      expect(job.progress, closeTo(0.62, 1e-9));
    });

    test('ETag: повторный опрос отдаёт 304 и кэш', () async {
      var calls = 0;
      final api = clientWith((request) async {
        calls++;
        if (calls == 1) {
          return _json(jobJson(), headers: {'etag': 'W/"v1"'});
        }
        expect(request.headers['If-None-Match'], 'W/"v1"');
        return http.Response('', 304);
      });

      final first = await api.fetchJob('job_01J8');
      final second = await api.fetchJob('job_01J8');

      expect(calls, 2);
      expect(identical(first, second), isTrue);
    });

    test('404 JOB_NOT_FOUND не повторяется', () async {
      var calls = 0;
      final api = clientWith((_) async {
        calls++;
        return _error('JOB_NOT_FOUND', 'Задача не найдена.', status: 404);
      });

      await expectLater(
        api.fetchJob('job_x'),
        throwsA(
          isA<RenderApiException>().having(
            (e) => e.code,
            'code',
            'JOB_NOT_FOUND',
          ),
        ),
      );
      expect(calls, 1);
    });
  });

  group('POST /jobs/{id}/cancel', () {
    test('отменяет задачу', () async {
      final api = clientWith((request) async {
        expect(request.url.path, '/jobs/job_01J8/cancel');
        return _json(jobJson(status: 'cancelled', phase: 'cancelled'));
      });

      final job = await api.cancelJob('job_01J8');
      expect(job.status, RenderStatus.cancelled);
      expect(job.isTerminal, isTrue);
    });

    test('409 JOB_ALREADY_TERMINAL отдаёт актуальное состояние', () async {
      final api = clientWith((request) async {
        if (request.url.path.endsWith('/cancel')) {
          return _error(
            'JOB_ALREADY_TERMINAL',
            'Задача уже завершена.',
            status: 409,
          );
        }
        return _json(
          jobJson(
            status: 'succeeded',
            phase: 'done',
            progress: 1,
            result: resultJson(),
          ),
        );
      });

      final job = await api.cancelJob('job_01J8');
      expect(job.isSucceeded, isTrue);
    });
  });

  group('GET /download', () {
    test('отдаёт свежую ссылку и имя файла', () async {
      final api = clientWith((request) async {
        expect(request.url.path, '/download');
        expect(request.url.queryParameters['jobId'], 'job_01J8');
        return _json({
          'downloadUrl': 'https://storage.googleapis.com/signed',
          'expiresAt': '2126-07-26T16:05:11.000Z',
          'sizeBytes': 36120044,
          'fileName': 'reelio_1080p.mp4',
        });
      });

      final download = await api.fetchDownload('job_01J8');
      expect(download.downloadUrl, contains('signed'));
      expect(download.fileName, 'reelio_1080p.mp4');
      expect(download.sizeBytes, 36120044);
      expect(download.isExpired, isFalse);
    });

    test('410 RESULT_EXPIRED сообщает об истёкшем артефакте', () async {
      final api = clientWith(
        (_) async => _error('RESULT_EXPIRED', 'Артефакт удалён.', status: 410),
      );

      await expectLater(
        api.fetchDownload('job_01J8'),
        throwsA(
          isA<RenderApiException>().having(
            (e) => e.code,
            'code',
            'RESULT_EXPIRED',
          ),
        ),
      );
    });

    test('ссылка с редиректом собирается по контракту', () {
      final api = clientWith((_) async => _json(jobJson()));
      final uri = api.downloadRedirectUri('job_01J8');
      expect(uri.path, '/download');
      expect(uri.queryParameters, {'jobId': 'job_01J8', 'redirect': '1'});
    });
  });

  group('Разрешения на прямую загрузку', () {
    test('разбирает signed URLs для всех материалов', () async {
      final api = clientWith((request) async {
        expect(request.url.path, '/uploads');
        final body = jsonDecode(request.body) as Map<String, dynamic>;
        final assets = body['assets'] as List;
        expect(assets.single, containsPair('contentType', 'video/mp4'));
        return _json({
          'uploads': [
            {
              'assetId': 'asset_a',
              'objectPath': 'projects/proj_9d1/sources/asset_a.mp4',
              'uploadUrl': 'https://storage.googleapis.com/put?sig=1',
              'method': 'PUT',
              'headers': {'Content-Type': 'video/mp4'},
              'expiresAt': '2126-07-26T16:05:11.000Z',
            },
          ],
        });
      });

      final tickets = await api.requestUploadTickets(
        projectId: 'proj_9d1',
        assets: sampleRequest().assets,
        contentTypes: const {'asset_a': 'video/mp4'},
      );

      expect(tickets, hasLength(1));
      expect(tickets.single.assetId, 'asset_a');
      expect(tickets.single.method, 'PUT');
      expect(tickets.single.isExpired, isFalse);
    });

    test('неполный ответ считается временной ошибкой', () async {
      final api = clientWith(
        (_) async => _json({'uploads': const []}),
        maxRetries: 0,
      );

      await expectLater(
        api.requestUploadTickets(
          projectId: 'proj_9d1',
          assets: sampleRequest().assets,
          contentTypes: const {'asset_a': 'video/mp4'},
        ),
        throwsA(
          isA<RenderApiException>().having(
            (e) => e.retryable,
            'retryable',
            isTrue,
          ),
        ),
      );
    });
  });

  test('без адреса backend запросы не уходят в сеть', () async {
    final api = RenderApiClient(
      baseUrl: '',
      client: MockClient((_) async => fail('запрос не должен уйти')),
    );

    expect(api.isConfigured, isFalse);
    await expectLater(
      api.fetchJob('job_01J8'),
      throwsA(
        isA<RenderApiException>().having(
          (e) => e.retryable,
          'retryable',
          isFalse,
        ),
      ),
    );
  });
}

/// Имитация сетевого сбоя без импорта `dart:io` (тесты идут и на web).
class SocketExceptionStub implements Exception {
  const SocketExceptionStub();
}
