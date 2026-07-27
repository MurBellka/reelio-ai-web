// Токены должны уходить в КАЖДОМ запросе к backend'у.
//
// Проверка нужна именно как регрессионная: забыть заголовок в одном новом
// методе легко, а проявится это отказом 401 уже у пользователя.

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:reelio_ai/models/edit_plan.dart';
import 'package:reelio_ai/models/enums.dart';
import 'package:reelio_ai/models/render_request.dart';
import 'package:reelio_ai/services/render_api_client.dart';

/// Источник токенов с подсчётом обращений.
class _FakeTokens implements AuthTokens {
  _FakeTokens({this.appCheck = 'app-check-456'});

  static const String id = 'id-token-123';

  final String? appCheck;
  int idCalls = 0;
  int appCheckCalls = 0;

  @override
  Future<String?> idToken() async {
    idCalls++;
    return id;
  }

  @override
  Future<String?> appCheckToken() async {
    appCheckCalls++;
    return appCheck;
  }
}

EditPlan _plan() => EditPlan(
  id: 'plan_1',
  prompt: 'тест',
  style: EditStyle.dynamicStyle,
  durationSeconds: 8,
  captions: CaptionSettings.defaults,
  music: MusicSettings.defaults,
  clips: const [
    EditClip(
      id: 'c1',
      filePath: '/local/a.mp4',
      type: MediaType.video,
      duration: 8,
      transition: 'cut',
      mediaId: 'asset_a',
      start: 0,
      end: 8,
    ),
  ],
);

RenderRequest _request() => RenderRequest(
  projectId: 'proj_1',
  plan: _plan(),
  assets: const [
    RenderAsset(
      id: 'asset_a',
      type: MediaType.video,
      objectPath: 'users/u1/projects/proj_1/sources/asset_a.mp4',
    ),
  ],
);

void main() {
  group('токены в заголовках', () {
    late List<http.Request> captured;

    RenderApiClient clientWith(_FakeTokens tokens, Object body) {
      captured = [];
      final mock = MockClient((req) async {
        captured.add(req);
        return http.Response(
          jsonEncode(body),
          200,
          headers: {'content-type': 'application/json'},
        );
      });
      return RenderApiClient(
        baseUrl: 'https://api.example.com',
        client: mock,
        tokens: tokens,
      );
    }

    test('POST /render несёт Authorization и App Check', () async {
      final tokens = _FakeTokens();
      final client = clientWith(tokens, {'jobId': 'job_1', 'status': 'queued'});

      await client.submitRender(_request());

      expect(captured, hasLength(1));
      expect(captured.single.headers['Authorization'], 'Bearer id-token-123');
      expect(captured.single.headers['X-Firebase-AppCheck'], 'app-check-456');
    });

    test('GET /jobs/{id} несёт токены', () async {
      final tokens = _FakeTokens();
      final client = clientWith(tokens, {
        'jobId': 'job_1',
        'status': 'running',
      });

      await client.fetchJob('job_1');

      expect(captured.single.headers['Authorization'], 'Bearer id-token-123');
      expect(captured.single.headers['X-Firebase-AppCheck'], 'app-check-456');
    });

    test('POST /jobs/{id}/cancel несёт токены', () async {
      final tokens = _FakeTokens();
      final client = clientWith(tokens, {
        'jobId': 'job_1',
        'status': 'cancelled',
      });

      await client.cancelJob('job_1');

      expect(captured.single.headers['Authorization'], 'Bearer id-token-123');
      expect(captured.single.headers['X-Firebase-AppCheck'], 'app-check-456');
    });

    test('GET /download несёт токены', () async {
      final tokens = _FakeTokens();
      final client = clientWith(tokens, {
        'downloadUrl': 'https://storage/x',
        'fileName': 'reel.mp4',
      });

      await client.fetchDownload('job_1');

      expect(captured.single.headers['Authorization'], 'Bearer id-token-123');
      expect(captured.single.headers['X-Firebase-AppCheck'], 'app-check-456');
    });

    test('POST /uploads несёт токены', () async {
      final tokens = _FakeTokens();
      final client = clientWith(tokens, {
        'uploads': [
          {
            'assetId': 'asset_a',
            'objectPath': 'users/u1/projects/proj_1/sources/asset_a.mp4',
            'uploadUrl': 'https://storage/upload',
            'expiresAt': '2030-01-01T00:00:00Z',
          },
        ],
      });

      await client.requestUploadTickets(
        projectId: 'proj_1',
        assets: const [
          RenderAsset(
            id: 'asset_a',
            type: MediaType.video,
            objectPath: 'users/u1/projects/proj_1/sources/asset_a.mp4',
          ),
        ],
        contentTypes: const {'asset_a': 'video/mp4'},
      );

      expect(captured.single.headers['Authorization'], 'Bearer id-token-123');
      expect(captured.single.headers['X-Firebase-AppCheck'], 'app-check-456');
    });

    test('токены запрашиваются заново на каждый запрос', () async {
      // ID token живёт час и обновляется SDK; закешированный протух бы
      // посреди сессии, поэтому берём его перед каждой отправкой.
      final tokens = _FakeTokens();
      final client = clientWith(tokens, {
        'jobId': 'job_1',
        'status': 'running',
      });

      await client.fetchJob('job_1');
      await client.fetchJob('job_2');

      expect(tokens.idCalls, 2);
      expect(tokens.appCheckCalls, 2);
    });

    test('без App Check запрос всё равно уходит с Authorization', () async {
      // Backend в режиме наблюдения пропустит такой запрос и отметит в логе —
      // отсутствие App Check не должно ломать сценарий пользователя.
      final tokens = _FakeTokens(appCheck: null);
      final client = clientWith(tokens, {
        'jobId': 'job_1',
        'status': 'running',
      });

      await client.fetchJob('job_1');

      expect(captured.single.headers['Authorization'], 'Bearer id-token-123');
      expect(
        captured.single.headers.containsKey('X-Firebase-AppCheck'),
        isFalse,
      );
    });

    test('без источника токенов заголовки не подставляются', () async {
      captured = [];
      final mock = MockClient((req) async {
        captured.add(req);
        return http.Response(
          '{"jobId":"job_1","status":"running"}',
          200,
          headers: {'content-type': 'application/json'},
        );
      });
      final client = RenderApiClient(
        baseUrl: 'https://api.example.com',
        client: mock,
      );

      await client.fetchJob('job_1');

      expect(captured.single.headers.containsKey('Authorization'), isFalse);
    });
  });
}
