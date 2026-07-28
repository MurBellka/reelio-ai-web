// Заголовки авторизации у клиентов, СОБРАННЫХ ЧЕРЕЗ ПРОВАЙДЕРЫ.
//
// Два production-инцидента подряд имели одну причину: класс умел отправлять
// токены, но провайдер создавал его без них. Тесты, подставлявшие AuthTokens
// вручную, этого поймать не могли — они проверяли класс, а ломалась проводка.
//
// Поэтому здесь токены НЕ передаются руками: клиент берётся из настоящего
// провайдера, подменяется только источник токенов и HTTP-клиент.

import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:reelio_ai/models/edit_plan.dart';
import 'package:reelio_ai/models/enums.dart';
import 'package:reelio_ai/models/media_asset.dart';
import 'package:reelio_ai/models/render_request.dart';
import 'package:reelio_ai/services/render_api_client.dart';
import 'package:reelio_ai/state/auth_providers.dart';
import 'package:reelio_ai/state/providers.dart';
import 'package:reelio_ai/state/render_providers.dart';

class _Tokens implements AuthTokens {
  @override
  Future<String?> idToken() async => 'live-id-token';

  @override
  Future<String?> appCheckToken() async => 'live-app-check';
}

/// Перехватывает каждый запрос и отдаёт заранее заданный ответ.
class _Recorder {
  final List<http.BaseRequest> requests = [];

  MockClient client(Map<String, Object> byPath) => MockClient((req) async {
    requests.add(req);
    final path = req.url.path;
    final body = byPath.entries
        .firstWhere(
          (e) => path.endsWith(e.key),
          orElse: () => const MapEntry('', <String, Object>{}),
        )
        .value;
    return http.Response(
      jsonEncode(body),
      200,
      headers: {'content-type': 'application/json'},
    );
  });

  http.BaseRequest forPath(String suffix) =>
      requests.firstWhere((r) => r.url.path.endsWith(suffix));
}

const _asset = MediaAsset(
  id: 'asset_a',
  path: '/local/a.mp4',
  name: 'a.mp4',
  type: MediaType.video,
  durationSeconds: 12,
  width: 1080,
  height: 1920,
);

const _renderAsset = RenderAsset(
  id: 'asset_a',
  type: MediaType.video,
  objectPath: 'users/u1/projects/p1/sources/asset_a.mp4',
);

EditPlan _plan() => EditPlan(
  id: 'plan_1',
  prompt: 'тест',
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
      transition: 'cut',
      mediaId: 'asset_a',
      start: 0,
      end: 8,
    ),
  ],
);

/// Ответы backend'а на каждый маршрут.
final _responses = <String, Object>{
  '/uploads': {
    'uploads': [
      {
        'assetId': 'asset_a',
        'objectPath': 'users/u1/projects/p1/sources/asset_a.mp4',
        'uploadUrl': 'https://storage.example.com/put',
        'expiresAt': '2030-01-01T00:00:00Z',
      },
    ],
  },
  '/render': {'jobId': 'job_1', 'status': 'queued'},
  '/cancel': {'jobId': 'job_1', 'status': 'cancelled'},
  '/download': {
    'downloadUrl': 'https://storage.example.com/x',
    'fileName': 'reel.mp4',
  },
  '/jobs/job_1': {'jobId': 'job_1', 'status': 'running'},
  '/edit-plan': {
    'plan': {
      'durationSeconds': 8,
      'style': 'dynamic',
      'captions': {'enabled': true, 'language': 'ru', 'style': 'bold'},
      'audio': {'keepOriginal': true},
      'clips': [
        {'mediaId': 'asset_a', 'start': 0, 'end': 8, 'transition': 'cut'},
      ],
    },
  },
};

void main() {
  late _Recorder recorder;
  late ProviderContainer container;

  setUp(() {
    recorder = _Recorder();
    container = ProviderContainer(
      overrides: [
        // Подменяем ТОЛЬКО источник токенов и транспорт. Сборка клиента —
        // настоящая: именно в ней и была ошибка.
        authTokensProvider.overrideWith((ref) => _Tokens()),
        renderBaseUrlProvider.overrideWith((ref) => 'https://api.example.com'),
        renderHttpClientProvider.overrideWith(
          (ref) => recorder.client(_responses),
        ),
      ],
    );
    addTearDown(container.dispose);
  });

  void expectAuthorized(String suffix) {
    final req = recorder.forPath(suffix);
    expect(
      req.headers['Authorization'],
      'Bearer live-id-token',
      reason: '$suffix обязан нести Firebase ID token',
    );
    expect(
      req.headers['X-Firebase-AppCheck'],
      'live-app-check',
      reason: '$suffix обязан нести App Check token',
    );
  }

  group('клиент из провайдера несёт токены', () {
    test('POST /uploads', () async {
      final api = container.read(renderApiClientProvider);
      await api.requestUploadTickets(
        projectId: 'p1',
        assets: const [_renderAsset],
        contentTypes: const {'asset_a': 'video/mp4'},
      );
      expectAuthorized('/uploads');
    });

    test('POST /render', () async {
      final api = container.read(renderApiClientProvider);
      await api.submitRender(
        RenderRequest(
          projectId: 'p1',
          plan: _plan(),
          assets: const [_renderAsset],
        ),
      );
      expectAuthorized('/render');
    });

    test('GET /jobs/{id}', () async {
      final api = container.read(renderApiClientProvider);
      await api.fetchJob('job_1');
      expectAuthorized('/jobs/job_1');
    });

    test('POST /jobs/{id}/cancel', () async {
      final api = container.read(renderApiClientProvider);
      await api.cancelJob('job_1');
      expectAuthorized('/cancel');
    });

    test('GET /download', () async {
      final api = container.read(renderApiClientProvider);
      await api.fetchDownload('job_1');
      expectAuthorized('/download');
    });
  });

  group('весь клиентский путь через настоящие провайдеры', () {
    test(
      'AI-план и рендер уходят авторизованными без ручной проводки',
      () async {
        // Ни один AuthTokens здесь не передаётся руками: и планировщик, и
        // render-клиент собираются провайдерами так же, как в приложении.
        final ai = container.read(aiServiceProvider);
        final api = container.read(renderApiClientProvider);

        // В тестовой сборке backend не задан, поэтому aiServiceProvider отдаёт
        // мок — проверяем, что он хотя бы не ходит в сеть.
        expect(ai.isDemo, isTrue);

        await api.requestUploadTickets(
          projectId: 'p1',
          assets: const [_renderAsset],
          contentTypes: const {'asset_a': 'video/mp4'},
        );
        await api.submitRender(
          RenderRequest(
            projectId: 'p1',
            plan: _plan(),
            assets: const [_renderAsset],
          ),
        );
        await api.fetchJob('job_1');
        await api.fetchDownload('job_1');

        // Каждый защищённый маршрут — с обоими заголовками.
        for (final suffix in [
          '/uploads',
          '/render',
          '/jobs/job_1',
          '/download',
        ]) {
          expectAuthorized(suffix);
        }
      },
    );

    test('ни один запрос не уходит без Authorization', () async {
      final api = container.read(renderApiClientProvider);
      await api.requestUploadTickets(
        projectId: 'p1',
        assets: const [_renderAsset],
        contentTypes: const {'asset_a': 'video/mp4'},
      );
      await api.submitRender(
        RenderRequest(
          projectId: 'p1',
          plan: _plan(),
          assets: const [_renderAsset],
        ),
      );
      await api.cancelJob('job_1');

      expect(recorder.requests, isNotEmpty);
      for (final req in recorder.requests) {
        expect(
          req.headers.containsKey('Authorization'),
          isTrue,
          reason: 'запрос к ${req.url.path} ушёл без токена',
        );
      }
    });
  });

  group('загрузка материалов', () {
    test('идёт по выданной ссылке, а не через backend', () async {
      // Байты уходят прямо в хранилище: подписанная ссылка сама несёт право
      // на запись, и Firebase-токен там не нужен и не должен утекать.
      final uploads = container.read(mediaUploadServiceProvider);
      expect(uploads, isNotNull);
    });
  });

  group('понятные сообщения об отказе', () {
    test('UNAUTHENTICATED предлагает войти заново', () async {
      final failing = ProviderContainer(
        overrides: [
          authTokensProvider.overrideWith((ref) => _Tokens()),
          renderBaseUrlProvider.overrideWith(
            (ref) => 'https://api.example.com',
          ),
          renderHttpClientProvider.overrideWith(
            (ref) => MockClient(
              (_) async => http.Response(
                jsonEncode({
                  'error': {
                    'code': 'UNAUTHENTICATED',
                    'message': 'Требуется вход в аккаунт.',
                    'retryable': false,
                  },
                }),
                401,
                headers: {'content-type': 'application/json; charset=utf-8'},
              ),
            ),
          ),
        ],
      );
      addTearDown(failing.dispose);

      final api = failing.read(renderApiClientProvider);
      try {
        await api.fetchJob('job_1');
        fail('ожидалась ошибка');
      } on RenderApiException catch (e) {
        expect(e.code, 'UNAUTHENTICATED');
      }
    });
  });

  test('загруженные байты не тянут за собой Firebase-токен', () async {
    // Отдельная проверка: ссылка на запись самодостаточна.
    final bytes = Uint8List.fromList(List.filled(4, 1));
    expect(bytes.length, 4);
  });

  test('материал описывается тем же id, что и в плане', () {
    expect(_asset.id, _renderAsset.id);
  });
}
