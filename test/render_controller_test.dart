import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:reelio_ai/core/constants.dart';
import 'package:reelio_ai/models/edit_plan.dart';
import 'package:reelio_ai/models/enums.dart';
import 'package:reelio_ai/models/media_asset.dart';
import 'package:reelio_ai/services/media_upload_service.dart';
import 'package:reelio_ai/services/render_api_client.dart';
import 'package:reelio_ai/state/providers.dart';
import 'package:reelio_ai/state/render_providers.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'render_job_test.dart' show jobJson, resultJson;

const _base = 'https://api.example.com';

const _asset = MediaAsset(
  id: 'assetA',
  path: '/local/a.mp4',
  name: 'a.mp4',
  type: MediaType.video,
  durationSeconds: 20,
  width: 1080,
  height: 1920,
);

EditPlan _plan() => EditPlan(
  id: 'plan_1',
  prompt: 'ролик',
  style: EditStyle.dynamicStyle,
  durationSeconds: 10,
  captions: CaptionSettings.defaults,
  music: MusicSettings.defaults,
  coverClipId: 'clip_1',
  clips: const [
    EditClip(
      id: 'clip_1',
      filePath: '/local/a.mp4',
      type: MediaType.video,
      duration: 10,
      start: 0,
      end: 10,
      transition: 'cut',
      mediaId: 'assetA',
      sourceName: 'a.mp4',
    ),
  ],
);

http.Response _json(Object body, {int status = 200}) => http.Response(
  jsonEncode(body),
  status,
  headers: const {'content-type': 'application/json'},
);

/// Управляемый бэкенд: отдаёт заранее заданную последовательность состояний.
class FakeBackend {
  FakeBackend({
    required this.jobStates,
    this.submitResponse,
    this.cancelResponse,
    this.downloadResponse,
    this.uploadsResponse,
  });

  /// Ответы `GET /jobs/{id}` по порядку; последний повторяется.
  final List<http.Response> jobStates;
  final http.Response? submitResponse;
  final http.Response? cancelResponse;
  final http.Response? downloadResponse;
  final http.Response? uploadsResponse;

  int jobPolls = 0;
  int submits = 0;
  int cancels = 0;
  final List<String> paths = [];

  Future<http.Response> handle(http.Request request) async {
    paths.add('${request.method} ${request.url.path}');
    final path = request.url.path;

    if (path == '/uploads') {
      return uploadsResponse ??
          _json({
            'uploads': [
              {
                'assetId': 'assetA',
                'objectPath': 'projects/p/sources/assetA.mp4',
                'uploadUrl': 'https://storage.googleapis.com/put?sig=1',
                'method': 'PUT',
              },
            ],
          });
    }
    if (path == '/render') {
      submits++;
      return submitResponse ??
          _json(
            jobJson(status: 'queued', phase: 'queued', progress: 0.01),
            status: 202,
          );
    }
    if (path.endsWith('/cancel')) {
      cancels++;
      return cancelResponse ??
          _json(jobJson(status: 'cancelled', phase: 'cancelled'));
    }
    if (path == '/download') {
      return downloadResponse ??
          _json({
            'downloadUrl': 'https://storage.googleapis.com/signed-fresh',
            'expiresAt': '2126-07-26T16:05:11.000Z',
            'sizeBytes': 36120044,
            'fileName': 'reelio_1080p.mp4',
          });
    }
    if (path.startsWith('/jobs/')) {
      final index = jobPolls < jobStates.length
          ? jobPolls
          : jobStates.length - 1;
      jobPolls++;
      return jobStates[index];
    }
    return _json({
      'error': {'code': 'NOT_FOUND', 'message': 'нет маршрута'},
    }, status: 404);
  }
}

ProviderContainer containerFor(
  FakeBackend backend, {
  Future<http.Response> Function(http.Request request)? uploadHandler,
}) {
  final container = ProviderContainer(
    overrides: [
      renderApiClientProvider.overrideWith(
        (ref) => RenderApiClient(
          baseUrl: _base,
          client: MockClient(backend.handle),
          maxRetries: 0,
        ),
      ),
      mediaUploadServiceProvider.overrideWith(
        (ref) => MediaUploadService(
          client: MockClient(
            uploadHandler ?? (_) async => http.Response('', 200),
          ),
          readBytes: (_) async => Uint8List.fromList(List.filled(8, 1)),
        ),
      ),
      renderPollConfigProvider.overrideWith(
        (ref) => const RenderPollConfig(
          initial: Duration(milliseconds: 10),
          max: Duration(milliseconds: 20),
          overallTimeout: Duration(seconds: 5),
          maxConsecutiveErrors: 2,
        ),
      ),
    ],
  );
  addTearDown(container.dispose);

  final project = container.read(projectProvider.notifier);
  project.addAssets(const [_asset]);
  project.setPlan(_plan());
  return container;
}

/// Ждёт выполнения условия, опрашивая состояние контроллера.
Future<void> waitFor(
  ProviderContainer container,
  bool Function(RenderUiState state) predicate, {
  Duration timeout = const Duration(seconds: 5),
}) async {
  final deadline = DateTime.now().add(timeout);
  while (DateTime.now().isBefore(deadline)) {
    if (predicate(container.read(renderControllerProvider))) return;
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
  fail(
    'Не дождались состояния. Текущее: '
    '${container.read(renderControllerProvider).stage}',
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('исходное состояние — готовый монтажный план', () {
    final container = containerFor(FakeBackend(jobStates: [_json(jobJson())]));
    final state = container.read(renderControllerProvider);

    expect(state.stage, RenderUiStage.planReady);
    expect(state.stage.label, 'Монтажный план готов');
    expect(state.canStart, isTrue);
    expect(state.isMp4Ready, isFalse);
    expect(state.canDownload, isFalse);
  });

  test('полный сценарий: загрузка → рендер → готовый MP4', () async {
    final backend = FakeBackend(
      jobStates: [
        _json(jobJson(status: 'running', phase: 'downloading', progress: 0.2)),
        _json(jobJson(status: 'running', phase: 'encoding', progress: 0.7)),
        _json(
          jobJson(
            status: 'succeeded',
            phase: 'done',
            progress: 1,
            result: resultJson(),
          ),
        ),
      ],
    );
    final container = containerFor(backend);
    final controller = container.read(renderControllerProvider.notifier);

    await controller.start();
    await waitFor(container, (s) => s.stage == RenderUiStage.ready);

    final state = container.read(renderControllerProvider);
    expect(state.stage.label, 'MP4 готов к скачиванию');
    expect(state.isMp4Ready, isTrue);
    expect(state.canDownload, isTrue);
    expect(state.overallProgress, 1);
    expect(state.job!.result!.sizeBytes, 36120044);
    expect(backend.submits, 1);
    expect(backend.paths.first, 'POST /uploads');
    expect(backend.paths, contains('POST /render'));
  });

  test('прогресс загрузки материалов виден до старта рендера', () async {
    final backend = FakeBackend(
      jobStates: [_json(jobJson(status: 'running', phase: 'rendering'))],
    );
    final container = containerFor(backend);
    final controller = container.read(renderControllerProvider.notifier);

    final seen = <RenderUiStage>[];
    container.listen(
      renderControllerProvider,
      (_, next) => seen.add(next.stage),
      fireImmediately: true,
    );

    await controller.start();
    await waitFor(container, (s) => s.stage == RenderUiStage.rendering);

    expect(seen, contains(RenderUiStage.uploading));
    expect(seen, contains(RenderUiStage.submitting));
    expect(RenderUiStage.uploading.label, 'Загружаем материалы');
    expect(RenderUiStage.rendering.label, 'MP4 создаётся');
  });

  test('успех без результата не выдаётся за готовность MP4', () async {
    final backend = FakeBackend(
      jobStates: [
        _json(jobJson(status: 'succeeded', phase: 'done', progress: 1)),
      ],
    );
    final container = containerFor(backend);
    final controller = container.read(renderControllerProvider.notifier);

    await controller.start();
    await waitFor(container, (s) => s.job?.isSucceeded ?? false);

    final state = container.read(renderControllerProvider);
    expect(state.isMp4Ready, isFalse);
    expect(state.canDownload, isFalse);
    expect(state.stage, isNot(RenderUiStage.ready));
  });

  test('ошибка задачи показывает состояние «Ошибка рендеринга»', () async {
    final backend = FakeBackend(
      jobStates: [
        _json(
          jobJson(
            status: 'failed',
            phase: 'failed',
            error: {
              'code': 'WORKER_FAILED',
              'message': 'FFmpeg вернул ненулевой код.',
              'retryable': true,
            },
          ),
        ),
      ],
    );
    final container = containerFor(backend);
    final controller = container.read(renderControllerProvider.notifier);

    await controller.start();
    await waitFor(container, (s) => s.stage == RenderUiStage.failed);

    final state = container.read(renderControllerProvider);
    expect(state.stage.label, 'Ошибка рендеринга');
    expect(state.error!.code, 'WORKER_FAILED');
    expect(state.detail, contains('FFmpeg'));
    expect(state.canRetry, isTrue);
    expect(state.isMp4Ready, isFalse);
  });

  test('невалидный план не уходит в сеть', () async {
    final backend = FakeBackend(jobStates: [_json(jobJson())]);
    final container = ProviderContainer(
      overrides: [
        renderApiClientProvider.overrideWith(
          (ref) => RenderApiClient(
            baseUrl: _base,
            client: MockClient(backend.handle),
            maxRetries: 0,
          ),
        ),
      ],
    );
    addTearDown(container.dispose);

    // Плана нет — сценарий обязан остановиться до загрузки материалов.
    await container.read(renderControllerProvider.notifier).start();

    final state = container.read(renderControllerProvider);
    expect(state.stage, RenderUiStage.failed);
    expect(state.error!.code, 'PLAN_INVALID');
    expect(backend.paths, isEmpty);
  });

  test('повтор после ошибки создаёт новую задачу', () async {
    final backend = FakeBackend(
      jobStates: [
        _json(
          jobJson(
            status: 'failed',
            phase: 'failed',
            error: {
              'code': 'WORKER_TIMEOUT',
              'message': 'Нет heartbeat.',
              'retryable': true,
            },
          ),
        ),
        _json(
          jobJson(
            status: 'succeeded',
            phase: 'done',
            progress: 1,
            result: resultJson(),
          ),
        ),
      ],
    );
    final container = containerFor(backend);
    final controller = container.read(renderControllerProvider.notifier);

    await controller.start();
    await waitFor(container, (s) => s.stage == RenderUiStage.failed);

    await controller.retry();
    await waitFor(container, (s) => s.stage == RenderUiStage.ready);

    expect(backend.submits, 2);
    expect(container.read(renderControllerProvider).isMp4Ready, isTrue);
  });

  test('отмена переводит задачу в состояние «Рендер отменён»', () async {
    final backend = FakeBackend(
      jobStates: [
        _json(jobJson(status: 'running', phase: 'rendering', progress: 0.4)),
      ],
    );
    final container = containerFor(backend);
    final controller = container.read(renderControllerProvider.notifier);

    await controller.start();
    await waitFor(container, (s) => s.stage == RenderUiStage.rendering);
    expect(container.read(renderControllerProvider).canCancel, isTrue);

    await controller.cancel();
    await waitFor(container, (s) => s.stage == RenderUiStage.cancelled);

    final state = container.read(renderControllerProvider);
    expect(backend.cancels, 1);
    expect(state.job!.isCancelled, isTrue);
    expect(state.canRetry, isTrue);
    expect(state.isMp4Ready, isFalse);
  });

  test('отмена во время загрузки материалов не создаёт задачу', () async {
    final backend = FakeBackend(jobStates: [_json(jobJson())]);
    late RenderController controller;
    final container = containerFor(
      backend,
      uploadHandler: (_) async {
        // Отменяем ровно в момент отправки байтов.
        await controller.cancel();
        return http.Response('', 200);
      },
    );
    controller = container.read(renderControllerProvider.notifier);

    await controller.start();

    final state = container.read(renderControllerProvider);
    expect(state.stage, RenderUiStage.cancelled);
    expect(backend.submits, 0);
  });

  group('Скачивание', () {
    test('перед скачиванием запрашивается свежая ссылка', () async {
      final backend = FakeBackend(
        jobStates: [
          _json(
            jobJson(
              status: 'succeeded',
              phase: 'done',
              progress: 1,
              result: resultJson(),
            ),
          ),
        ],
      );
      final container = containerFor(backend);
      final controller = container.read(renderControllerProvider.notifier);

      await controller.start();
      await waitFor(container, (s) => s.stage == RenderUiStage.ready);

      final download = await controller.requestDownload();

      expect(download, isNotNull);
      expect(download!.downloadUrl, contains('signed-fresh'));
      expect(download.fileName, 'reelio_1080p.mp4');
      expect(backend.paths, contains('GET /download'));
      expect(
        container.read(renderControllerProvider).preparingDownload,
        isFalse,
      );
    });

    test('истёкший артефакт объясняется пользователю', () async {
      final backend = FakeBackend(
        jobStates: [
          _json(
            jobJson(
              status: 'succeeded',
              phase: 'done',
              progress: 1,
              result: resultJson(),
            ),
          ),
        ],
        downloadResponse: _json({
          'error': {
            'code': 'RESULT_EXPIRED',
            'message': 'Артефакт удалён по lifecycle.',
            'retryable': false,
          },
        }, status: 410),
      );
      final container = containerFor(backend);
      final controller = container.read(renderControllerProvider.notifier);

      await controller.start();
      await waitFor(container, (s) => s.stage == RenderUiStage.ready);

      final download = await controller.requestDownload();

      expect(download, isNull);
      final state = container.read(renderControllerProvider);
      expect(state.stage, RenderUiStage.failed);
      expect(state.error!.code, 'RESULT_EXPIRED');
      expect(state.detail, contains('Запустите рендер заново'));
    });
  });

  group('Восстановление после перезагрузки', () {
    test('активная задача подхватывается и доводится до готовности', () async {
      final backend = FakeBackend(
        jobStates: [
          _json(jobJson(status: 'running', phase: 'encoding', progress: 0.8)),
          _json(
            jobJson(
              status: 'succeeded',
              phase: 'done',
              progress: 1,
              result: resultJson(),
            ),
          ),
        ],
      );
      final container = containerFor(backend);
      final projectId = container.read(projectProvider).id;

      SharedPreferences.setMockInitialValues({
        AppConstants.activeRenderJobKey: jsonEncode({
          'projectId': projectId,
          'jobId': 'job_01J8',
        }),
      });

      await container.read(renderControllerProvider.notifier).restore();
      await waitFor(container, (s) => s.stage == RenderUiStage.ready);

      final state = container.read(renderControllerProvider);
      expect(state.job!.jobId, 'job_01J8');
      expect(state.isMp4Ready, isTrue);
      expect(backend.submits, 0); // повторный рендер не заказывался
    });

    test('задача другого проекта не восстанавливается', () async {
      final backend = FakeBackend(jobStates: [_json(jobJson())]);
      final container = containerFor(backend);

      SharedPreferences.setMockInitialValues({
        AppConstants.activeRenderJobKey: jsonEncode({
          'projectId': 'другой-проект',
          'jobId': 'job_01J8',
        }),
      });

      await container.read(renderControllerProvider.notifier).restore();

      expect(container.read(renderControllerProvider).job, isNull);
      expect(backend.paths, isEmpty);
    });

    test('исчезнувшая задача забывается без ошибки на экране', () async {
      final backend = FakeBackend(
        jobStates: [
          _json({
            'error': {
              'code': 'JOB_NOT_FOUND',
              'message': 'Задача не найдена.',
              'retryable': false,
            },
          }, status: 404),
        ],
      );
      final container = containerFor(backend);
      final projectId = container.read(projectProvider).id;

      SharedPreferences.setMockInitialValues({
        AppConstants.activeRenderJobKey: jsonEncode({
          'projectId': projectId,
          'jobId': 'job_gone',
        }),
      });

      await container.read(renderControllerProvider.notifier).restore();

      final state = container.read(renderControllerProvider);
      expect(state.stage, RenderUiStage.planReady);
      expect(state.error, isNull);

      final storage = container.read(storageServiceProvider);
      expect(await storage.loadActiveRenderJob(projectId), isNull);
    });
  });

  test('поллинг замедляется, пока состояние не меняется', () async {
    const config = RenderPollConfig(
      initial: Duration(seconds: 2),
      max: Duration(seconds: 10),
    );

    expect(
      config.nextInterval(const Duration(seconds: 2)),
      const Duration(seconds: 3),
    );
    expect(
      config.nextInterval(const Duration(seconds: 8)),
      const Duration(seconds: 10),
    );
    // Верхняя граница не превышается.
    expect(
      config.nextInterval(const Duration(seconds: 10)),
      const Duration(seconds: 10),
    );
  });

  test('обрыв связи не выдаёт задачу за проваленную молча', () async {
    var polls = 0;
    final backend = FakeBackend(jobStates: [_json(jobJson())]);
    final container = ProviderContainer(
      overrides: [
        renderApiClientProvider.overrideWith(
          (ref) => RenderApiClient(
            baseUrl: _base,
            client: MockClient((request) async {
              if (request.url.path.startsWith('/jobs/')) {
                polls++;
                throw const _NetworkDown();
              }
              return backend.handle(request);
            }),
            maxRetries: 0,
          ),
        ),
        mediaUploadServiceProvider.overrideWith(
          (ref) => MediaUploadService(
            client: MockClient((_) async => http.Response('', 200)),
            readBytes: (_) async => Uint8List.fromList(List.filled(8, 1)),
          ),
        ),
        renderPollConfigProvider.overrideWith(
          (ref) => const RenderPollConfig(
            initial: Duration(milliseconds: 5),
            max: Duration(milliseconds: 10),
            maxConsecutiveErrors: 2,
          ),
        ),
      ],
    );
    addTearDown(container.dispose);

    final project = container.read(projectProvider.notifier);
    project.addAssets(const [_asset]);
    project.setPlan(_plan());

    await container.read(renderControllerProvider.notifier).start();
    await waitFor(container, (s) => s.stage == RenderUiStage.failed);

    final state = container.read(renderControllerProvider);
    expect(polls, greaterThanOrEqualTo(2));
    expect(state.error!.message, contains('связь'));
    expect(state.canRetry, isTrue);
  });
}

class _NetworkDown implements Exception {
  const _NetworkDown();
}
