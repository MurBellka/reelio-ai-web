import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:reelio_ai/features/export/export_screen.dart';
import 'package:reelio_ai/features/render/render_section.dart';
import 'package:reelio_ai/models/edit_plan.dart';
import 'package:reelio_ai/models/enums.dart';
import 'package:reelio_ai/models/export_settings.dart';
import 'package:reelio_ai/models/media_asset.dart';
import 'package:reelio_ai/services/media_upload_service.dart';
import 'package:reelio_ai/services/backend_version_service.dart';
import 'package:reelio_ai/state/auth_providers.dart';
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

EditPlan _plan({ExportSettings? export}) => EditPlan(
  id: 'plan_1',
  prompt: 'ролик',
  style: EditStyle.dynamicStyle,
  durationSeconds: 10,
  captions: CaptionSettings.defaults,
  audio: AudioSettings.defaults,
  coverClipId: 'clip_1',
  export: export ?? ExportSettings.defaults,
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

/// Бэкенд для UI-тестов: последовательность состояний задачи.
Future<http.Response> Function(http.Request) backendWith(
  List<http.Response> jobStates,
) {
  var polls = 0;
  return (request) async {
    final path = request.url.path;
    if (path == '/uploads') {
      return _json({
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
      return _json(
        jobJson(status: 'queued', phase: 'queued', progress: 0.01),
        status: 202,
      );
    }
    if (path.startsWith('/jobs/')) {
      final index = polls < jobStates.length ? polls : jobStates.length - 1;
      polls++;
      return jobStates[index];
    }
    return _json({
      'error': {'code': 'NOT_FOUND', 'message': 'нет'},
    }, status: 404);
  };
}

/// Контейнер с подменёнными сетью, загрузчиком и темпом поллинга.
ProviderContainer containerFor(List<http.Response> jobStates) {
  final container = ProviderContainer(
    overrides: [
      // Вошедший пользователь: без uid путь объекта не построить, и рендер
      // честно откажется стартовать.
      currentUidProvider.overrideWithValue('testuid'),
      // Гейт версии API: в тестах backend считаем уже обновлённым, иначе
      // проверка ушла бы в сеть и заблокировала бы рендер.
      backendVersionServiceProvider.overrideWith(
        (ref) => BackendVersionService(
          baseUrl: _base,
          client: MockClient(
            (_) async => http.Response(
              '{"ok":true,"apiVersion":2,"authRequired":true}',
              200,
              headers: {'content-type': 'application/json'},
            ),
          ),
        ),
      ),
      renderApiClientProvider.overrideWith(
        (ref) => RenderApiClient(
          baseUrl: _base,
          client: MockClient(backendWith(jobStates)),
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
          initial: Duration(milliseconds: 10),
          max: Duration(milliseconds: 20),
          overallTimeout: Duration(seconds: 5),
        ),
      ),
    ],
  );
  addTearDown(container.dispose);
  return container;
}

Future<ProviderContainer> pumpRenderSection(
  WidgetTester tester,
  List<http.Response> jobStates, {
  EditPlan? plan,
}) async {
  final container = containerFor(jobStates);

  final project = container.read(projectProvider.notifier);
  project.addAssets(const [_asset]);
  project.setPlan(plan ?? _plan());

  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: const MaterialApp(
        home: Scaffold(body: SingleChildScrollView(child: RenderSection())),
      ),
    ),
  );
  await tester.pump();
  return container;
}

/// Останавливает поллинг, чтобы тест не завершился с висящим таймером.
Future<void> stopPolling(
  WidgetTester tester,
  ProviderContainer container,
) async {
  container.invalidate(renderControllerProvider);
  await tester.pump();
}

/// Прокручивает время, пока идут поллинг и сетевые ответы.
Future<void> advance(WidgetTester tester, {int steps = 40}) async {
  for (var i = 0; i < steps; i++) {
    await tester.pump(const Duration(milliseconds: 20));
  }
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('Блок рендера', () {
    testWidgets('показывает готовый план и предлагает собрать MP4', (
      tester,
    ) async {
      await pumpRenderSection(tester, [_json(jobJson())]);

      expect(find.text('Монтажный план готов'), findsOneWidget);
      expect(find.text('Собрать MP4 на сервере'), findsOneWidget);
      expect(find.text('Скачать MP4'), findsNothing);
      expect(find.byType(LinearProgressIndicator), findsNothing);
    });

    testWidgets('во время рендера показывает прогресс и отмену', (
      tester,
    ) async {
      final container = await pumpRenderSection(tester, [
        _json(jobJson(status: 'running', phase: 'encoding', progress: 0.62)),
      ]);

      await tester.tap(find.text('Собрать MP4 на сервере'));
      await advance(tester);

      expect(find.text('MP4 создаётся'), findsOneWidget);
      expect(find.textContaining('62 %'), findsOneWidget);
      expect(find.text('Отменить рендер'), findsOneWidget);
      expect(find.byType(LinearProgressIndicator), findsOneWidget);
      // Пока не готово — скачивать нечего.
      expect(find.text('Скачать MP4'), findsNothing);

      await stopPolling(tester, container);
    });

    testWidgets('готовый MP4 показывает параметры файла и кнопку скачивания', (
      tester,
    ) async {
      await pumpRenderSection(tester, [
        _json(jobJson(status: 'running', phase: 'encoding', progress: 0.7)),
        _json(
          jobJson(
            status: 'succeeded',
            phase: 'done',
            progress: 1,
            result: resultJson(),
          ),
        ),
      ]);

      await tester.tap(find.text('Собрать MP4 на сервере'));
      await advance(tester);

      expect(find.text('MP4 готов к скачиванию'), findsOneWidget);
      expect(find.text('Скачать MP4'), findsOneWidget);
      expect(find.text('Готовый файл'), findsOneWidget);
      expect(find.text('1080×1920'), findsOneWidget);
      expect(find.text('30 сек'), findsOneWidget);
      expect(find.text('34.4 МБ'), findsOneWidget);
      expect(find.text('30 FPS'), findsOneWidget);
    });

    testWidgets('ошибка рендера предлагает повтор', (tester) async {
      await pumpRenderSection(tester, [
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
      ]);

      await tester.tap(find.text('Собрать MP4 на сервере'));
      await advance(tester);

      expect(find.text('Ошибка рендеринга'), findsOneWidget);
      expect(find.text('FFmpeg вернул ненулевой код.'), findsOneWidget);
      expect(find.text('Повторить рендер'), findsOneWidget);
      expect(find.text('Скачать MP4'), findsNothing);
    });

    testWidgets('отменённая задача сообщает об остановке', (tester) async {
      await pumpRenderSection(tester, [
        _json(jobJson(status: 'cancelled', phase: 'cancelled', progress: 0.3)),
      ]);

      await tester.tap(find.text('Собрать MP4 на сервере'));
      await advance(tester);

      expect(find.text('Рендер отменён'), findsOneWidget);
      expect(find.text('Повторить рендер'), findsOneWidget);
    });

    testWidgets('активная задача восстанавливается после перезагрузки', (
      tester,
    ) async {
      final container = containerFor([
        _json(jobJson(status: 'running', phase: 'encoding', progress: 0.5)),
      ]);

      final project = container.read(projectProvider.notifier);
      project.addAssets(const [_asset]);
      project.setPlan(_plan());

      await container
          .read(storageServiceProvider)
          .saveActiveRenderJob(
            projectId: container.read(projectProvider).id,
            jobId: 'job_01J8',
          );

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(
            home: Scaffold(body: SingleChildScrollView(child: RenderSection())),
          ),
        ),
      );
      await advance(tester);

      expect(find.text('MP4 создаётся'), findsOneWidget);
      expect(container.read(renderControllerProvider).job!.jobId, 'job_01J8');

      await stopPolling(tester, container);
    });
  });

  group('Выбор качества экспорта', () {
    Future<ProviderContainer> pumpExport(
      WidgetTester tester, {
      ExportSettings? export,
    }) async {
      final container = containerFor([_json(jobJson())]);

      final project = container.read(projectProvider.notifier);
      project.addAssets(const [_asset]);
      project.setPlan(_plan(export: export));

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(home: ExportScreen()),
        ),
      );
      await tester.pump();
      return container;
    }

    testWidgets('доступны 720p, 1080p, 2K, 4K и максимальное', (tester) async {
      await pumpExport(tester);

      expect(find.text('720p · 1280p'), findsOneWidget);
      expect(find.text('Full HD · 1920p'), findsOneWidget);
      expect(find.text('2K · 2560p'), findsOneWidget);
      expect(find.text('4K · 3840p'), findsOneWidget);
      expect(find.text('Максимальное'), findsOneWidget);
    });

    testWidgets('выбор 4K обновляет параметры и предупреждает об апскейле', (
      tester,
    ) async {
      final container = await pumpExport(tester);

      await tester.tap(find.text('4K · 3840p'));
      await tester.pump();

      final export = container.read(projectProvider).plan!.export;
      expect(export.resolution, ExportResolution.fourK2160);
      expect(export.width, 2160);
      expect(export.height, 3840);
      expect(export.isUpscale, isTrue);

      expect(find.text('9:16 · 2160×3840'), findsOneWidget);
      expect(find.textContaining('выше исходного материала'), findsOneWidget);
    });

    testWidgets('выбор 720p не считается апскейлом', (tester) async {
      final container = await pumpExport(tester);

      await tester.tap(find.text('720p · 1280p'));
      await tester.pump();

      final export = container.read(projectProvider).plan!.export;
      expect(export.height, 1280);
      expect(export.isUpscale, isFalse);
      expect(find.textContaining('выше исходного материала'), findsNothing);
    });

    testWidgets('показывает длительность и оценку размера', (tester) async {
      await pumpExport(tester);

      expect(find.text('Длительность'), findsOneWidget);
      expect(find.text('10 сек'), findsOneWidget);
      expect(find.text('Размер (оценка)'), findsOneWidget);
      expect(find.text('30 FPS'), findsOneWidget);
    });
  });
}
