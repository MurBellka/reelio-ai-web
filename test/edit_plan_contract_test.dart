// Контракт EditPlan v2: consumer-сторона (§ фикс client↔server plan mismatch).
//
// Читает ТУ ЖЕ общую фикстуру, что проверяет backend-producer-тест
// (test-fixtures/edit_plan_v2.json). Проверяет: серверный план парсится без
// crash; transition — полноценный объект (type/durationSeconds/intensity, не
// сводится к строке); mediaId сохраняется; filePath отсутствует и не утекает в
// /render; v1-строка читается; некорректный план даёт контролируемую ошибку.

import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:reelio_ai/models/edit_plan.dart';
import 'package:reelio_ai/models/edit_request.dart';
import 'package:reelio_ai/models/enums.dart';
import 'package:reelio_ai/models/media_asset.dart';
import 'package:reelio_ai/models/transition.dart';
import 'package:reelio_ai/services/analysis_api_client.dart';
import 'package:reelio_ai/services/beta_ai_editing_service.dart';
import 'package:reelio_ai/services/render_api_client.dart';

Map<String, dynamic> _fixture(String name) =>
    jsonDecode(File('test-fixtures/$name').readAsStringSync())
        as Map<String, dynamic>;

class _Tokens implements AuthTokens {
  const _Tokens();
  @override
  Future<String?> idToken() async => 'fb-token';
  @override
  Future<String?> appCheckToken() async => null;
}

void main() {
  group('EditPlan v2 consumer', () {
    test(
      'парсит реальный серверный план без crash и сохраняет объект перехода',
      () {
        final plan = EditPlan.fromJson(_fixture('edit_plan_v2.json'));

        expect(plan.clips, hasLength(2));
        final c0 = plan.clips[0];
        final c1 = plan.clips[1];

        // Адресация по mediaId, локального пути нет (сервер его не шлёт).
        expect(c0.mediaId, 'asset_a');
        expect(c0.filePath, isNull);

        // transition — ОБЪЕКТ: тип + длительность + интенсивность сохранены.
        expect(c0.transition.type, TransitionType.cut);
        expect(c0.transition.durationSeconds, isNull);
        expect(c1.transition.type, TransitionType.dissolve);
        expect(c1.transition.durationSeconds, 0.45);
        expect(c1.transition.intensity, TransitionIntensity.dynamicIntensity);

        // TextOverlay и звук сохраняются после разбора.
        expect(plan.textOverlays, hasLength(1));
        expect(plan.textOverlays.first.text, 'Привет, мир');
        expect(plan.audio.keepOriginal, isTrue);
      },
    );

    test(
      'reserialize сохраняет mediaId и ПОЛНЫЙ объект перехода; filePath НЕ уходит',
      () {
        final plan = EditPlan.fromJson(_fixture('edit_plan_v2.json'));
        final json = plan.toJson();
        final clips = (json['clips'] as List).cast<Map<String, dynamic>>();

        for (final c in clips) {
          expect(
            c.containsKey('filePath'),
            isFalse,
            reason: 'filePath не сериализуется',
          );
          expect(c['mediaId'], isNotNull);
          expect(c['transition'], isA<Map>());
          final t = (c['transition'] as Map).cast<String, dynamic>();
          expect(t.keys.toSet(), {'type', 'durationSeconds', 'intensity'});
        }
        expect(clips[1]['transition']['durationSeconds'], 0.45);
        expect(clips[1]['transition']['intensity'], 'dynamic');
      },
    );

    test(
      'локальный filePath не утекает в /render (даже если проставлен на клиенте)',
      () {
        final plan = EditPlan.fromJson(_fixture('edit_plan_v2.json'));
        // Клиентское обогащение локальным путём для предпросмотра.
        final enriched = plan.copyWith(
          clips: plan.clips
              .map((c) => c.withLocalPath('/local/device/preview.mp4'))
              .toList(),
        );
        expect(enriched.clips.first.filePath, '/local/device/preview.mp4');

        // В сериализации плана (уходит в /render) пути нет.
        final clips = (enriched.toJson()['clips'] as List)
            .cast<Map<String, dynamic>>();
        for (final c in clips) {
          expect(c.containsKey('filePath'), isFalse);
        }
      },
    );

    test(
      'v1: строковый transition читается (обратная совместимость), filePath игнорируется на выходе',
      () {
        final plan = EditPlan.fromJson(_fixture('edit_plan_v1.json'));
        final c = plan.clips.single;
        // crossfade (v1) → dissolve, объект собран.
        expect(c.transition.type, TransitionType.dissolve);
        expect(c.mediaId, 'asset_a');
        // filePath из старого черновика прочитан…
        expect(c.filePath, '/local/device/old_video.mp4');
        // …но НЕ уходит наружу.
        final out =
            (plan.toJson()['clips'] as List).first as Map<String, dynamic>;
        expect(out.containsKey('filePath'), isFalse);
        expect(out['transition'], isA<Map>());
      },
    );

    test('отсутствие filePath в v2 — НЕ ошибка', () {
      expect(
        () => EditPlan.fromJson(_fixture('edit_plan_v2.json')),
        returnsNormally,
      );
    });

    test(
      'неизвестный тип перехода → контрактный fallback + note (не молча)',
      () {
        final spec = TransitionSpec.fromJson({
          'type': 'zoom-blast-9000',
          'durationSeconds': 0.5,
          'intensity': 'calm',
        });
        expect(spec.type, TransitionType.fallback);
        expect(spec.intensity, TransitionIntensity.calm);
        expect(spec.durationSeconds, 0.5);
        expect(spec.note, isNotNull);
      },
    );

    test(
      'malformed план → контролируемая EditPlanFormatException, а не type-cast crash',
      () {
        expect(
          () => EditPlan.fromJson({'id': 'p', 'clips': []}),
          throwsA(isA<EditPlanFormatException>()),
        );
        expect(
          () => EditPlan.fromJson({
            'id': 'p',
            'clips': [
              {'id': 'c1', 'duration': 0},
            ],
          }),
          throwsA(isA<EditPlanFormatException>()),
        );
        expect(
          () => EditPlan.fromJson({
            'clips': [
              {'id': 'c1', 'duration': 2},
            ],
          }),
          throwsA(isA<EditPlanFormatException>()),
        );
      },
    );
  });

  group('BetaAiEditingService полный поток', () {
    test(
      'upload → analysis → poll → getPlan возвращает EditPlan без падения',
      () async {
        final planJson = _fixture('edit_plan_v2.json');
        final mock = MockClient((req) async {
          final p = req.url.path;
          if (req.method == 'POST' && p == '/analysis') {
            return http.Response(
              jsonEncode({
                'analysis': {
                  'analysisId': 'an_live',
                  'status': 'queued',
                  'phase': 'queued',
                  'progress': 0,
                },
              }),
              202,
              headers: {'content-type': 'application/json'},
            );
          }
          if (req.method == 'GET' && p == '/analysis/an_live') {
            return http.Response(
              jsonEncode({
                'analysis': {
                  'analysisId': 'an_live',
                  'status': 'succeeded',
                  'phase': 'done',
                  'progress': 1,
                },
              }),
              200,
              headers: {'content-type': 'application/json'},
            );
          }
          if (req.method == 'POST' && p == '/analysis/an_live/plan') {
            return http.Response(
              jsonEncode({'plan': planJson}),
              200,
              headers: {'content-type': 'application/json'},
            );
          }
          return http.Response('not found', 404);
        });

        final api = AnalysisApiClient(
          baseUrl: 'https://beta.example',
          tokens: const _Tokens(),
          client: mock,
        );
        final service = BetaAiEditingService(
          client: api,
          projectId: 'proj1',
          uploadAssets: (request, {onProgress, isCancelled}) async => {
            for (final a in request.assets)
              a.id: 'users/u/projects/proj1/sources/${a.id}.mp4',
          },
        );

        const request = EditRequest(
          prompt: 'ролик',
          style: EditStyle.dynamicStyle,
          durationSeconds: 10,
          assets: [
            MediaAsset(
              id: 'asset_a',
              path: '/local/a.mp4',
              name: 'a.mp4',
              type: MediaType.video,
              durationSeconds: 12,
            ),
          ],
          captions: CaptionSettings.defaults,
          audio: AudioSettings.defaults,
        );

        final plan = await service.createEditPlan(request);
        expect(plan.clips, isNotEmpty);
        expect(plan.clips.first.transition.type, TransitionType.cut);
        expect(plan.clips.first.mediaId, 'asset_a');
      },
    );
  });

  group('изоляция материалов по mediaId', () {
    test('два файла с одинаковым именем не путаются: адресация по mediaId', () {
      // Два материала с ОДИНАКОВЫМ путём/именем, но разными id.
      const a1 = MediaAsset(
        id: 'asset_a',
        path: '/same/name.mp4',
        name: 'name.mp4',
        type: MediaType.video,
      );
      const a2 = MediaAsset(
        id: 'asset_b',
        path: '/same/name.mp4',
        name: 'name.mp4',
        type: MediaType.video,
      );
      final byId = {
        for (final a in [a1, a2]) a.id: a,
      };

      final plan = EditPlan.fromJson(_fixture('edit_plan_v2.json'));
      // clip_2 ссылается на asset_b — по mediaId должен резолвиться именно он,
      // а не первый попавшийся по имени.
      final resolved = byId[plan.clips[1].mediaId];
      expect(resolved, same(a2));
      expect(resolved!.id, 'asset_b');
    });
  });
}
