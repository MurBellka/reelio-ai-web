// §4D UX: раздельный видимый прогресс загрузки и AI-анализа.
//
// Контроллер обработки превращает прогресс планировщика в два явных этапа и
// разводит ошибки загрузки и анализа. Часть тестов использует облегчённый
// фейк планировщика (детерминированные шаги прогресса), часть — НАСТОЯЩИЙ
// beta-пайплайн (координатор загрузки + MockClient), чтобы проверить реальный
// побайтовый прогресс и переиспользование манифеста рендером.

import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:reelio_ai/models/edit_plan.dart';
import 'package:reelio_ai/models/edit_request.dart';
import 'package:reelio_ai/models/enums.dart';
import 'package:reelio_ai/models/media_asset.dart';
import 'package:reelio_ai/models/upload_manifest.dart';
import 'package:reelio_ai/models/upload_ticket.dart';
import 'package:reelio_ai/services/ai_editing_service.dart';
import 'package:reelio_ai/services/analysis_api_client.dart';
import 'package:reelio_ai/services/beta_ai_editing_service.dart';
import 'package:reelio_ai/services/media_upload_service.dart';
import 'package:reelio_ai/services/render_api_client.dart';
import 'package:reelio_ai/services/upload_coordinator.dart';
import 'package:reelio_ai/state/auth_providers.dart';
import 'package:reelio_ai/state/processing_providers.dart';
import 'package:reelio_ai/state/providers.dart';
import 'package:reelio_ai/state/render_providers.dart';

// --- Хелперы ----------------------------------------------------------------

MediaAsset _asset(String id, {double durationSeconds = 5}) => MediaAsset(
  id: id,
  path: '/local/$id.mp4',
  name: '$id.mp4',
  type: MediaType.video,
  durationSeconds: durationSeconds,
);

EditPlan _plan() => EditPlan.fromJson({
  'id': 'plan_1',
  'prompt': 'ролик',
  'style': 'dynamicStyle',
  'durationSeconds': 8,
  'captions': {'enabled': true, 'language': 'ru', 'style': 'bold'},
  'audio': {'keepOriginal': true},
  'clips': [
    {
      'id': 'c1',
      'filePath': '/local/a1.mp4',
      'type': 'video',
      'duration': 8,
      'transition': 'dissolve',
      'mediaId': 'a1',
      'start': 0,
      'end': 8,
    },
  ],
});

http.Response _json(Object body, {int status = 200}) => http.Response(
  jsonEncode(body),
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

/// Планировщик под управлением сценария: сам вызывает [onProgress], затем
/// отдаёт план либо бросает заданную ошибку. Между шагами — полный оборот
/// цикла событий, чтобы промежуточные состояния успели наблюдаться.
class ScriptedAiService implements AiEditingService {
  ScriptedAiService(this.steps, {this.plan, this.throwsAfter});

  final List<ProcessingProgress> steps;
  final EditPlan? plan;
  final Object? throwsAfter;
  bool cancelled = false;

  @override
  bool get isDemo => false;

  @override
  void cancel() => cancelled = true;

  @override
  Future<EditPlan> createEditPlan(
    EditRequest request, {
    ProcessingReporter? onProgress,
  }) async {
    for (final step in steps) {
      if (cancelled) throw const AiEditingException('Запрос отменён.');
      onProgress?.call(step);
      await Future<void>.delayed(Duration.zero);
    }
    if (cancelled) throw const AiEditingException('Запрос отменён.');
    if (throwsAfter != null) throw throwsAfter!;
    return plan ?? _plan();
  }
}

/// Контейнер с проектом из [assets] и заданным планировщиком/uid.
ProviderContainer _container({
  required AiEditingService service,
  List<MediaAsset> assets = const [],
  UploadManifest manifest = UploadManifest.empty,
  String uid = 'u',
}) {
  final container = ProviderContainer(
    overrides: [
      aiServiceProvider.overrideWith((ref) => service),
      currentUidProvider.overrideWith((ref) => uid),
    ],
  );
  addTearDown(container.dispose);
  if (assets.isNotEmpty) {
    container.read(projectProvider.notifier).addAssets(assets);
  }
  if (manifest.assets.isNotEmpty) {
    container
        .read(projectProvider.notifier)
        .recordUploads(manifest.assets.values.toList());
  }
  return container;
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('Раздельные этапы: загрузка 0→100, затем анализ 0→100', () {
    test('монотонный прогресс, 100 % — только по завершению этапа', () async {
      final service = ScriptedAiService([
        ProcessingProgress.uploading(
          const UploadProgress(
            completedFiles: 0,
            totalFiles: 2,
            currentFileName: 'a1.mp4',
            currentFileFraction: 0.5,
          ),
        ),
        ProcessingProgress.uploading(
          const UploadProgress(
            completedFiles: 1,
            totalFiles: 2,
            currentFileName: 'a2.mp4',
            currentFileFraction: 0.5,
          ),
        ),
        ProcessingProgress.uploading(
          const UploadProgress(completedFiles: 2, totalFiles: 2),
        ),
        const ProcessingProgress.analyzing(
          analysisFraction: 0,
          analysisMessage: 'старт',
        ),
        const ProcessingProgress.analyzing(analysisFraction: 0.5),
        const ProcessingProgress.analyzing(analysisFraction: 1),
      ]);
      final container = _container(
        service: service,
        assets: [_asset('a1'), _asset('a2')],
      );

      final snaps = <ProcessingUiState>[];
      container.listen(processingControllerProvider, (_, next) {
        snaps.add(next);
      });

      await container.read(processingControllerProvider.notifier).start();

      // Этапы прошли по порядку.
      final stages = snaps.map((s) => s.stage).toList();
      expect(stages.contains(ProcessingStage.uploading), isTrue);
      expect(stages.contains(ProcessingStage.analyzing), isTrue);
      expect(stages.last, ProcessingStage.done);
      expect(
        stages.indexOf(ProcessingStage.uploading) <
            stages.indexOf(ProcessingStage.analyzing),
        isTrue,
        reason: 'загрузка предшествует анализу',
      );

      // Загрузка дошла до 100 % именно на этапе загрузки.
      final uploadFull = snaps.firstWhere(
        (s) => s.stage == ProcessingStage.uploading && s.uploadProgress >= 1,
      );
      expect(uploadFull.upload.completedFiles, 2);

      // Пока идёт анализ, полоса не показывает 100 %.
      for (final s in snaps.where(
        (s) => s.stage == ProcessingStage.analyzing,
      )) {
        expect(s.analysisProgress < 1, isTrue);
      }
      // 100 % анализа — только когда всё готово.
      expect(snaps.last.isDone, isTrue);
      expect(snaps.last.analysisProgress, 1);

      // Монотонность доли анализа.
      double prev = -1;
      for (final s in snaps.where(
        (s) => s.stage == ProcessingStage.analyzing,
      )) {
        expect(s.analysisFraction >= prev, isTrue);
        prev = s.analysisFraction;
      }

      // План сохранён в проект, этап проекта переведён в preview.
      final project = container.read(projectProvider);
      expect(project.plan, isNotNull);
      expect(project.stage, AppStage.preview);
    });
  });

  group('Настоящий beta-пайплайн: побайтовый прогресс', () {
    test('несколько файлов разного размера — реальный upload → analysis', () async {
      final uploadRequests = <int>[]; // сколько материалов просили за раз
      final sizes = {'a1': 4096, 'a2': 16384, 'a3': 1024};

      final renderApi = RenderApiClient(
        baseUrl: 'https://beta.example',
        client: MockClient((req) async {
          final body = jsonDecode(req.body) as Map<String, dynamic>;
          final list = (body['assets'] as List).cast<Map<String, dynamic>>();
          uploadRequests.add(list.length);
          return _json({
            'uploads': [
              for (final a in list)
                {
                  'assetId': a['id'],
                  'objectPath':
                      'users/u/projects/${body['projectId']}/sources/${a['id']}.mp4',
                  'uploadUrl': 'https://storage.example/put/${a['id']}',
                  'method': 'PUT',
                },
            ],
          });
        }),
      );
      final uploader = MediaUploadService(
        client: MockClient((_) async => http.Response('', 200)),
        readBytes: (path) async {
          final id = path.split('/').last.replaceAll('.mp4', '');
          return Uint8List.fromList(List.filled(sizes[id] ?? 512, 7));
        },
        chunkSize: 512, // мелкие порции → несколько шагов прогресса на файл
      );
      final coordinator = UploadCoordinator(api: renderApi, uploader: uploader);

      final analysis = AnalysisApiClient(
        baseUrl: 'https://beta.example',
        client: MockClient((req) async {
          final path = req.url.path;
          if (path == '/analysis') {
            return _json({
              'analysis': {'analysisId': 'an_1', 'status': 'queued'},
            }, status: 202);
          }
          if (path == '/analysis/an_1') {
            return _json({
              'analysis': {
                'analysisId': 'an_1',
                'status': 'succeeded',
                'phase': 'done',
                'progress': 1,
              },
            });
          }
          return _json({'contractVersion': 2, 'plan': _planJson()});
        }),
      );

      final container = ProviderContainer(
        overrides: [
          currentUidProvider.overrideWith((ref) => 'u'),
          uploadCoordinatorProvider.overrideWith((ref) => coordinator),
          analysisApiClientProvider.overrideWith((ref) => analysis),
          aiServiceProvider.overrideWith((ref) {
            return BetaAiEditingService(
              client: ref.read(analysisApiClientProvider),
              projectId: ref.read(projectProvider).id,
              uploadAssets: (request, {onProgress, isCancelled}) async {
                final project = ref.read(projectProvider);
                final result = await ref
                    .read(uploadCoordinatorProvider)
                    .ensureUploaded(
                      assets: request.assets,
                      manifest: project.uploadManifest,
                      ownerUid: ref.read(currentUidProvider) ?? '',
                      projectId: project.id,
                      onProgress: onProgress,
                      isCancelled: isCancelled,
                    );
                ref
                    .read(projectProvider.notifier)
                    .recordUploads(result.uploaded);
                return result.objectPaths;
              },
              pollInterval: const Duration(milliseconds: 1),
            );
          }),
        ],
      );
      addTearDown(container.dispose);
      container.read(projectProvider.notifier).addAssets([
        _asset('a1'),
        _asset('a2'),
        _asset('a3'),
      ]);

      final uploadFractions = <double>[];
      final fileNames = <String>{};
      container.listen(processingControllerProvider, (_, next) {
        if (next.stage == ProcessingStage.uploading) {
          uploadFractions.add(next.uploadProgress);
          if (next.currentFileName.isNotEmpty) {
            fileNames.add(next.currentFileName);
          }
        }
      });

      await container.read(processingControllerProvider.notifier).start();

      // Реальный побайтовый прогресс: несколько промежуточных значений, растущих.
      expect(uploadFractions.length, greaterThan(3));
      for (var i = 1; i < uploadFractions.length; i++) {
        expect(uploadFractions[i] >= uploadFractions[i - 1], isTrue);
      }
      expect(uploadFractions.last, 1);
      // Разные файлы засветились по имени (без внутренних путей).
      expect(fileNames, containsAll(<String>{'a1.mp4', 'a2.mp4', 'a3.mp4'}));
      for (final n in fileNames) {
        expect(n.contains('/'), isFalse, reason: 'без внутренних путей');
      }

      // Загрузка была ровно одна, на все три материала.
      expect(uploadRequests, [3]);

      // Готово: план собран, размеры в манифесте = фактические байты.
      final project = container.read(projectProvider);
      expect(project.plan, isNotNull);
      expect(project.uploadManifest.forMedia('a1')!.sizeBytes, 4096);
      expect(project.uploadManifest.forMedia('a2')!.sizeBytes, 16384);
      expect(project.uploadManifest.forMedia('a3')!.sizeBytes, 1024);

      // §4D.9: повторный рендер не грузит уже загруженные материалы.
      final before = uploadRequests.length;
      final reuse = await coordinator.ensureUploaded(
        assets: [_asset('a1'), _asset('a2'), _asset('a3')],
        manifest: project.uploadManifest,
        ownerUid: 'u',
        projectId: project.id,
      );
      expect(reuse.uploaded, isEmpty);
      expect(
        uploadRequests.length,
        before,
        reason: 'ни одного нового /uploads',
      );
    });
  });

  group('Восстановление после reload', () {
    test('материалы уже в манифесте — этап загрузки пропущен', () async {
      // Только анализ: сервис НЕ шлёт uploading (загрузка была до перезагрузки).
      final service = ScriptedAiService([
        const ProcessingProgress.analyzing(analysisFraction: 0.4),
        const ProcessingProgress.analyzing(analysisFraction: 1),
      ]);
      final manifest = UploadManifest.empty.withUploaded([
        UploadedAsset(
          mediaId: 'a1',
          objectPath: 'users/u/projects/p/sources/a1.mp4',
          sizeBytes: 100,
          uploadedAt: DateTime(2026),
        ),
      ]);
      final container = _container(
        service: service,
        assets: [_asset('a1')],
        manifest: manifest,
      );

      final stages = <ProcessingStage>[];
      container.listen(
        processingControllerProvider,
        (_, next) => stages.add(next.stage),
      );

      await container.read(processingControllerProvider.notifier).start();

      expect(
        stages.contains(ProcessingStage.uploading),
        isFalse,
        reason: 'восстановленный проект сразу переходит к анализу',
      );
      expect(stages.last, ProcessingStage.done);
    });
  });

  group('Отмена и повтор', () {
    test(
      'отмена во время анализа → cancelled, повтор доводит до конца',
      () async {
        final service = _CancellableService();
        final container = _container(service: service, assets: [_asset('a1')]);
        final controller = container.read(
          processingControllerProvider.notifier,
        );

        // Стартуем и отменяем в процессе.
        final run = controller.start();
        await Future<void>.delayed(Duration.zero);
        controller.cancel();
        await run;

        expect(service.cancelled, isTrue);
        expect(
          container.read(processingControllerProvider).stage,
          ProcessingStage.cancelled,
        );
        expect(container.read(processingControllerProvider).canRetry, isTrue);

        // Повтор — успешно.
        service.cancelled = false;
        service.failNext = false;
        await controller.retry();
        expect(
          container.read(processingControllerProvider).stage,
          ProcessingStage.done,
        );
      },
    );
  });

  group('Ошибка загрузки ≠ ошибка Gemini', () {
    test('MediaUploadException помечается как этап загрузки', () async {
      final service = ScriptedAiService(
        [
          ProcessingProgress.uploading(
            const UploadProgress(
              completedFiles: 0,
              totalFiles: 1,
              currentFileName: 'a1.mp4',
              currentFileFraction: 0.3,
            ),
          ),
        ],
        throwsAfter: const MediaUploadException(
          'Хранилище отклонило загрузку «a1.mp4» (500).',
        ),
      );
      final container = _container(service: service, assets: [_asset('a1')]);

      await container.read(processingControllerProvider.notifier).start();

      final state = container.read(processingControllerProvider);
      expect(state.stage, ProcessingStage.failed);
      expect(state.error!.isUpload, isTrue);
      expect(state.error!.message.contains('Хранилище'), isTrue);
      // Это не обезличенная «ошибка Gemini».
      expect(
        state.error!.message.contains('Не удалось собрать ролик'),
        isFalse,
      );
    });

    test('AiEditingException помечается как этап анализа', () async {
      final service = ScriptedAiService(
        [const ProcessingProgress.analyzing(analysisFraction: 0.2)],
        throwsAfter: const AiEditingException(
          'Не удалось разобрать материалы.',
        ),
      );
      final container = _container(service: service, assets: [_asset('a1')]);

      await container.read(processingControllerProvider.notifier).start();

      final state = container.read(processingControllerProvider);
      expect(state.stage, ProcessingStage.failed);
      expect(state.error!.isUpload, isFalse);
    });
  });
}

Map<String, dynamic> _planJson() => {
  'id': 'plan_1',
  'prompt': 'ролик',
  'style': 'dynamicStyle',
  'durationSeconds': 8,
  'captions': {'enabled': true, 'language': 'ru', 'style': 'bold'},
  'audio': {'keepOriginal': true},
  'clips': [
    {
      'id': 'c1',
      'filePath': '/local/a1.mp4',
      'type': 'video',
      'duration': 8,
      'transition': 'dissolve',
      'mediaId': 'a1',
      'start': 0,
      'end': 8,
    },
  ],
};

/// Планировщик, который на первом прогоне повисает на анализе до отмены, а на
/// повторе завершается успешно.
class _CancellableService implements AiEditingService {
  bool cancelled = false;
  bool failNext = true;

  @override
  bool get isDemo => false;

  @override
  void cancel() => cancelled = true;

  @override
  Future<EditPlan> createEditPlan(
    EditRequest request, {
    ProcessingReporter? onProgress,
  }) async {
    onProgress?.call(const ProcessingProgress.analyzing(analysisFraction: 0.3));
    // Даём внешнему коду шанс вызвать cancel().
    for (var i = 0; i < 5; i++) {
      await Future<void>.delayed(Duration.zero);
      if (cancelled) throw const AiEditingException('Запрос отменён.');
    }
    return _plan();
  }
}
