// Integration 4C: подключение Flutter к beta backend.
//
// AppConfig-флаги — compile-time const, поэтому режим v2 проверяется на уровне
// клиентов и планировщика с внедрёнными адресом и транспортом (MockClient), а
// не через dart-define. Флаг по умолчанию false → приложение остаётся v1.

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:reelio_ai/core/app_config.dart';
import 'package:reelio_ai/models/edit_plan.dart';
import 'package:reelio_ai/models/edit_request.dart';
import 'package:reelio_ai/models/enums.dart';
import 'package:reelio_ai/models/media_asset.dart';
import 'package:reelio_ai/services/ai_editing_service.dart';
import 'package:reelio_ai/services/analysis_api_client.dart';
import 'package:reelio_ai/services/beta_ai_editing_service.dart';

const _base = 'https://beta.example';

http.Response _json(Object body, {int status = 200}) => http.Response(
  jsonEncode(body),
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

Map<String, dynamic> _v2Plan() => {
  'id': 'plan_1',
  'prompt': 'ролик',
  'style': 'dynamicStyle',
  'durationSeconds': 8,
  'captions': {'enabled': true, 'language': 'ru', 'style': 'bold'},
  'audio': {'keepOriginal': true},
  'textOverlays': [
    {
      'id': 't1',
      'text': 'Привет',
      'position': {'anchor': 'top', 'x': 0.5, 'y': 0.18},
    },
  ],
  'clips': [
    {
      'id': 'c1',
      'filePath': '/a.mp4',
      'type': 'video',
      'duration': 8,
      'transition': 'dissolve',
      'mediaId': 'asset_1',
      'start': 0,
      'end': 8,
    },
  ],
};

EditRequest _request() => const EditRequest(
  assets: [
    MediaAsset(
      id: 'asset_1',
      path: '/a.mp4',
      name: 'a.mp4',
      type: MediaType.video,
      durationSeconds: 8,
    ),
  ],
  prompt: 'ролик',
  style: EditStyle.dynamicStyle,
  durationSeconds: 8,
  captions: CaptionSettings.defaults,
  audio: AudioSettings.defaults,
);

void main() {
  group('AppConfig: флаг v2 по умолчанию выключен → v1', () {
    test('дефолты сохраняют текущий публичный v1', () {
      expect(AppConfig.v2Enabled, isFalse);
      expect(AppConfig.isV2Active, isFalse);
      expect(AppConfig.betaUnavailable, isFalse);
      // Активный адрес совпадает с v1 (оба пусты без dart-define).
      expect(AppConfig.activeBackendUrl, AppConfig.backendBaseUrl);
    });
  });

  group('AnalysisApiClient', () {
    test(
      'createAnalysis возвращает id; ошибка 401 — понятное сообщение',
      () async {
        final ok = AnalysisApiClient(
          baseUrl: _base,
          client: MockClient(
            (_) async => _json({
              'analysis': {'analysisId': 'an_1', 'status': 'queued'},
            }, status: 202),
          ),
        );
        expect(
          await ok.createAnalysis(
            projectId: 'p1',
            assets: [
              {
                'id': 'asset_1',
                'type': 'video',
                'objectPath': 'users/u/projects/p1/sources/asset_1.mp4',
              },
            ],
          ),
          'an_1',
        );

        final denied = AnalysisApiClient(
          baseUrl: _base,
          client: MockClient(
            (_) async => _json({
              'error': {
                'code': 'UNAUTHENTICATED',
                'message': 'no',
                'retryable': false,
              },
            }, status: 401),
          ),
        );
        await expectLater(
          denied.createAnalysis(projectId: 'p1', assets: const []),
          throwsA(isA<AiEditingException>()),
        );
      },
    );

    test(
      'getPlan парсит EditPlan v2 (audio, textOverlays, без music)',
      () async {
        final client = AnalysisApiClient(
          baseUrl: _base,
          client: MockClient(
            (_) async => _json({'contractVersion': 2, 'plan': _v2Plan()}),
          ),
        );
        final plan = await client.getPlan(
          'an_1',
          prompt: 'ролик',
          targetDurationSeconds: 8,
        );
        expect(plan.clips, hasLength(1));
        expect(plan.audio.keepOriginal, isTrue);
        expect(plan.textOverlays, hasLength(1));
      },
    );

    test('usage читает остаток квоты', () async {
      final client = AnalysisApiClient(
        baseUrl: _base,
        client: MockClient(
          (_) async => _json({
            'day': '2026-07-28',
            'analyses': {'used': 2, 'limit': 20},
          }),
        ),
      );
      final u = await client.usage(projectId: 'p1');
      expect((u['analyses'] as Map)['used'], 2);
    });
  });

  group('BetaAiEditingService: upload → analysis → plan', () {
    test('полный пайплайн отдаёт EditPlan v2', () async {
      final calls = <String>[];
      final http0 = MockClient((req) async {
        final path = req.url.path;
        calls.add('${req.method} $path');
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
        if (path == '/analysis/an_1/plan') {
          return _json({'contractVersion': 2, 'plan': _v2Plan()});
        }
        return _json({
          'error': {'code': 'ANALYSIS_NOT_FOUND', 'message': 'нет'},
        }, status: 404);
      });

      var uploaded = false;
      final service = BetaAiEditingService(
        client: AnalysisApiClient(baseUrl: _base, client: http0),
        projectId: 'p1',
        uploadAssets: (request, {onProgress, isCancelled}) async {
          uploaded = true;
          return {
            for (final a in request.assets)
              a.id: 'users/u/projects/p1/sources/${a.id}.mp4',
          };
        },
        pollInterval: const Duration(milliseconds: 1),
      );

      final plan = await service.createEditPlan(_request());
      expect(uploaded, isTrue, reason: 'материалы загружены до анализа');
      expect(plan.audio.keepOriginal, isTrue);
      expect(plan.clips, isNotEmpty);
      // Порядок: сначала /analysis, потом статус, потом план.
      expect(calls.first, 'POST /analysis');
      expect(calls.last, 'POST /analysis/an_1/plan');
    });

    test('провалившийся анализ пробрасывает понятную ошибку', () async {
      final http0 = MockClient((req) async {
        final path = req.url.path;
        if (path == '/analysis') {
          return _json({
            'analysis': {'analysisId': 'an_2', 'status': 'queued'},
          }, status: 202);
        }
        if (path == '/analysis/an_2') {
          return _json({
            'analysis': {
              'analysisId': 'an_2',
              'status': 'failed',
              'error': {'message': 'сбой модели'},
            },
          });
        }
        return _json({}, status: 404);
      });
      final service = BetaAiEditingService(
        client: AnalysisApiClient(baseUrl: _base, client: http0),
        projectId: 'p1',
        uploadAssets: (r, {onProgress, isCancelled}) async => {
          for (final a in r.assets)
            a.id: 'users/u/projects/p1/sources/${a.id}.mp4',
        },
        pollInterval: const Duration(milliseconds: 1),
      );
      await expectLater(
        service.createEditPlan(_request()),
        throwsA(isA<AiEditingException>()),
      );
    });
  });
}
