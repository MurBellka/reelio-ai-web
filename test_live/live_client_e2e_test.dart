// E2E через НАСТОЯЩИЙ клиентский код против production backend.
//
// Проверяется именно то, что сломалось в бете: GeminiAiEditingService и
// RenderApiClient — те самые классы, которыми пользуется приложение. Прошлый
// e2e подставлял токены в обход клиента и потому пропустил отсутствие
// заголовков.
//
// DOM-автоматизация здесь бесполезна: Flutter Web рисует в canvas, кликать не
// по чему. Значение имеет код клиента, и он выполняется буквально этот.
//
// Запускается отдельно от обычного набора (каталог test_live), потому что
// ходит в сеть и тратит квоту живого сервиса.

import 'dart:convert';
import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:reelio_ai/models/edit_plan.dart';
import 'package:reelio_ai/models/transition.dart';
import 'package:reelio_ai/models/edit_request.dart';
import 'package:reelio_ai/models/enums.dart';
import 'package:reelio_ai/models/media_asset.dart';
import 'package:reelio_ai/models/render_job.dart';
import 'package:reelio_ai/models/render_request.dart';
import 'package:reelio_ai/services/gemini_ai_editing_service.dart';
import 'package:reelio_ai/services/render_api_client.dart';
import 'package:reelio_ai/state/auth_providers.dart';
import 'package:reelio_ai/state/render_providers.dart';

/// Токены живого пользователя, полученные снаружи и переданные в тест.
class _LiveTokens implements AuthTokens {
  const _LiveTokens(this._idToken);

  final String _idToken;

  @override
  Future<String?> idToken() async => _idToken;

  // App Check в режиме наблюдения: backend пропустит запрос и отметит в логе.
  @override
  Future<String?> appCheckToken() async => null;
}

void main() {
  final baseUrl = Platform.environment['LIVE_BACKEND_URL'] ?? '';
  final idToken = Platform.environment['LIVE_ID_TOKEN'] ?? '';
  final uid = Platform.environment['LIVE_UID'] ?? '';
  final projectId = Platform.environment['LIVE_PROJECT_ID'] ?? '';
  final objectPath = Platform.environment['LIVE_OBJECT_PATH'] ?? '';

  final ready = baseUrl.isNotEmpty && idToken.isNotEmpty && uid.isNotEmpty;

  test(
    'клиент получает план от /edit-plan (200)',
    () async {
      if (!ready) {
        fail('нет LIVE_* окружения: тест запускается только скриптом live-e2e');
      }

      // Ровно тот класс, который отправлял запрос без заголовков.
      final service = GeminiAiEditingService(
        baseUrl: baseUrl,
        tokens: _LiveTokens(idToken),
        minInterval: Duration.zero,
      );

      final plan = await service.createEditPlan(
        const EditRequest(
          prompt: 'динамичный ролик из тестового материала',
          style: EditStyle.dynamicStyle,
          durationSeconds: 8,
          assets: [
            MediaAsset(
              id: 'asset_a',
              path: '/local/a.mp4',
              name: 'a.mp4',
              type: MediaType.video,
              durationSeconds: 12,
              width: 1080,
              height: 1920,
            ),
          ],
          captions: CaptionSettings.defaults,
          audio: AudioSettings.defaults,
        ),
      );

      expect(plan.clips, isNotEmpty, reason: 'план обязан содержать клипы');
      expect(plan.durationSeconds, greaterThan(0));
      // ignore: avoid_print
      print('EDIT_PLAN_OK clips=${plan.clips.length}');
    },
    timeout: const Timeout(Duration(minutes: 3)),
  );

  test(
    'клиент доводит рендер до настоящего MP4',
    () async {
      if (!ready || objectPath.isEmpty) {
        fail('нет LIVE_* окружения');
      }

      // Клиент берётся ИЗ ПРОВАЙДЕРА, а не собирается руками: hotfix 2 был
      // именно в проводке, и ручная сборка такой дефект не поймала бы.
      final container = ProviderContainer(
        overrides: [
          authTokensProvider.overrideWith((ref) => _LiveTokens(idToken)),
          renderBaseUrlProvider.overrideWith((ref) => baseUrl),
        ],
      );
      addTearDown(container.dispose);
      final api = container.read(renderApiClientProvider);

      final request = RenderRequest(
        projectId: projectId,
        plan: EditPlan(
          id: 'plan_live',
          prompt: 'live e2e',
          style: EditStyle.dynamicStyle,
          durationSeconds: 8,
          captions: CaptionSettings.defaults,
          audio: AudioSettings.defaults,
          clips: const [
            EditClip(
              id: 'c1',
              filePath: '/local/a.mp4',
              type: MediaType.video,
              duration: 8,
              transition: TransitionSpec(type: TransitionType.cut),
              mediaId: 'asset_a',
              start: 1,
              end: 9,
            ),
          ],
        ),
        assets: [
          RenderAsset(
            id: 'asset_a',
            type: MediaType.video,
            objectPath: objectPath,
            durationSeconds: 12,
            width: 1080,
            height: 1920,
          ),
        ],
        exportResolution: ExportResolution.hd720,
        exportFps: 30,
        idempotencyKey: 'live-$projectId',
      );

      var job = await api.submitRender(request);
      expect(job.jobId, isNotEmpty);

      final deadline = DateTime.now().add(const Duration(minutes: 12));
      while (!job.status.isTerminal) {
        if (DateTime.now().isAfter(deadline)) fail('таймаут ожидания рендера');
        await Future<void>.delayed(const Duration(seconds: 4));
        job = await api.fetchJob(job.jobId);
      }

      expect(
        job.status,
        RenderStatus.succeeded,
        reason: 'ошибка: ${job.error?.message}',
      );
      expect(job.result, isNotNull);

      final download = await api.fetchDownload(job.jobId);
      expect(download.downloadUrl, isNotEmpty);

      // Скачиваем и убеждаемся, что это настоящий MP4, а не страница ошибки.
      final bytes = await http.readBytes(Uri.parse(download.downloadUrl));
      expect(bytes.length, greaterThan(100000));
      // Сигнатура ISO-BMFF: байты 4..8 равны 'ftyp'.
      expect(utf8.decode(bytes.sublist(4, 8)), 'ftyp');

      final out = File('${Directory.systemTemp.path}/live_out.mp4');
      await out.writeAsBytes(bytes);
      // ignore: avoid_print
      print('RENDER_OK bytes=${bytes.length} file=${out.path}');
    },
    timeout: const Timeout(Duration(minutes: 15)),
  );
}
