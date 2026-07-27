// Заголовки авторизации в запросе к /edit-plan.
//
// Регрессия из публичной беты: сервис отправлял только Content-Type, а backend
// защищён входом и App Check. Настоящий клиент получал 401 сразу после
// успешного входа, и пользователь видел «Сервер отклонил запрос на монтаж».
//
// E2E это пропустил, потому что скрипт подставлял токены в обход клиента.
// Поэтому здесь перехватывается ИМЕННО запрос GeminiAiEditingService.

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:reelio_ai/models/edit_plan.dart';
import 'package:reelio_ai/models/edit_request.dart';
import 'package:reelio_ai/models/enums.dart';
import 'package:reelio_ai/models/media_asset.dart';
import 'package:reelio_ai/services/ai_editing_service.dart';
import 'package:reelio_ai/services/gemini_ai_editing_service.dart';
import 'package:reelio_ai/services/render_api_client.dart' show AuthTokens;

/// Источник токенов с подсчётом обращений и возможностью «протухания».
class _Tokens implements AuthTokens {
  _Tokens({this.id = 'id-token-1', this.appCheck = 'app-check-1'});

  String? id;
  String? appCheck;
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

const _asset = MediaAsset(
  id: 'asset_a',
  path: '/local/a.mp4',
  name: 'a.mp4',
  type: MediaType.video,
  durationSeconds: 12,
  width: 1080,
  height: 1920,
);

EditRequest _request() => const EditRequest(
  prompt: 'динамичный ролик',
  style: EditStyle.dynamicStyle,
  durationSeconds: 8,
  assets: [_asset],
  captions: CaptionSettings.defaults,
  music: MusicSettings.defaults,
);

/// Ответ backend'а с валидным планом.
String _planBody() => jsonEncode({
  'plan': {
    'durationSeconds': 8,
    'style': 'dynamic',
    'captions': {'enabled': true, 'language': 'ru', 'style': 'bold'},
    'music': {'mood': 'chill', 'volume': 0.7},
    'clips': [
      {'mediaId': 'asset_a', 'start': 0, 'end': 8, 'transition': 'cut'},
    ],
  },
});

String _errorBody(String code, String message) => jsonEncode({
  'error': {'code': code, 'message': message, 'retryable': false},
});

/// Ответ с ошибкой. charset обязателен: без него http.Response кодирует тело
/// в latin1 и падает на кириллице ещё внутри мока — ошибка выглядела бы как
/// обрыв связи, а не как отказ backend'а.
http.Response _errorResponse(String code, String message, int status) =>
    http.Response(
      _errorBody(code, message),
      status,
      headers: {'content-type': 'application/json; charset=utf-8'},
    );

GeminiAiEditingService _service(
  _Tokens? tokens,
  Future<http.Response> Function(http.Request) handler, {
  int maxRetries = 0,
}) => GeminiAiEditingService(
  baseUrl: 'https://api.example.com',
  client: MockClient(handler),
  tokens: tokens,
  maxRetries: maxRetries,
  minInterval: Duration.zero,
);

void main() {
  group('заголовки запроса к /edit-plan', () {
    test('уходят Authorization и X-Firebase-AppCheck', () async {
      http.Request? captured;
      final tokens = _Tokens();
      final service = _service(tokens, (req) async {
        captured = req;
        return http.Response(
          _planBody(),
          200,
          headers: {'content-type': 'application/json'},
        );
      });

      await service.createEditPlan(_request());

      expect(captured, isNotNull);
      expect(captured!.headers['Authorization'], 'Bearer id-token-1');
      expect(captured!.headers['X-Firebase-AppCheck'], 'app-check-1');
      expect(captured!.headers['Content-Type'], contains('application/json'));
    });

    test('без App Check запрос всё равно уходит с Authorization', () async {
      // Режим наблюдения на backend пропускает такой запрос: отсутствие
      // App Check не должно ломать сценарий пользователя.
      http.Request? captured;
      final service = _service(_Tokens(appCheck: null), (req) async {
        captured = req;
        return http.Response(
          _planBody(),
          200,
          headers: {'content-type': 'application/json'},
        );
      });

      await service.createEditPlan(_request());

      expect(captured!.headers['Authorization'], 'Bearer id-token-1');
      expect(captured!.headers.containsKey('X-Firebase-AppCheck'), isFalse);
    });

    test('без источника токенов заголовки не подставляются', () async {
      http.Request? captured;
      final service = _service(null, (req) async {
        captured = req;
        return http.Response(
          _planBody(),
          200,
          headers: {'content-type': 'application/json'},
        );
      });

      await service.createEditPlan(_request());

      expect(captured!.headers.containsKey('Authorization'), isFalse);
    });
  });

  group('обновление токена', () {
    test('токены берутся заново на каждой попытке', () async {
      // ID token живёт час. Если взять его один раз в конструкторе, при
      // повторе после долгого ожидания ушёл бы уже протухший.
      final tokens = _Tokens();
      var calls = 0;
      final service = _service(tokens, (_) async {
        calls++;
        // Первая попытка — временная ошибка, вторая успешна.
        if (calls == 1) return http.Response('{}', 503);
        return http.Response(
          _planBody(),
          200,
          headers: {'content-type': 'application/json'},
        );
      }, maxRetries: 1);

      await service.createEditPlan(_request());

      expect(calls, 2);
      expect(
        tokens.idCalls,
        2,
        reason: 'токен обязан запрашиваться перед каждой попыткой',
      );
      expect(tokens.appCheckCalls, 2);
    });

    test('обновлённый токен попадает в повторный запрос', () async {
      final tokens = _Tokens(id: 'stale-token');
      final sent = <String?>[];
      var calls = 0;
      final service = _service(tokens, (req) async {
        sent.add(req.headers['Authorization']);
        calls++;
        if (calls == 1) {
          // Между попытками SDK обновил токен.
          tokens.id = 'fresh-token';
          return http.Response('{}', 503);
        }
        return http.Response(
          _planBody(),
          200,
          headers: {'content-type': 'application/json'},
        );
      }, maxRetries: 1);

      await service.createEditPlan(_request());

      expect(sent, ['Bearer stale-token', 'Bearer fresh-token']);
    });

    test('отсутствующий ID token не подставляется пустым', () async {
      // Пользователь вышел из аккаунта: заголовка быть не должно вовсе,
      // иначе backend получил бы «Bearer » и это выглядело бы как атака.
      http.Request? captured;
      final service = _service(_Tokens(id: null), (req) async {
        captured = req;
        return _errorResponse(
          'UNAUTHENTICATED',
          'Требуется вход в аккаунт.',
          401,
        );
      });

      await expectLater(
        service.createEditPlan(_request()),
        throwsA(isA<AiEditingException>()),
      );
      expect(captured!.headers.containsKey('Authorization'), isFalse);
    });
  });

  group('понятные сообщения об ошибках', () {
    Future<String> messageFor(String code, String message, int status) async {
      final service = _service(
        _Tokens(),
        (_) async => _errorResponse(code, message, status),
      );
      try {
        await service.createEditPlan(_request());
        fail('ожидалась ошибка');
      } on AiEditingException catch (e) {
        return e.message;
      }
    }

    test('истёкшая сессия предлагает войти заново', () async {
      final m = await messageFor(
        'UNAUTHENTICATED',
        'Сессия недействительна.',
        401,
      );
      expect(m, contains('Войдите'));
      expect(m, isNot(contains('Сервер отклонил')));
    });

    test('неподтверждённая почта объясняет, что сделать', () async {
      final m = await messageFor(
        'EMAIL_NOT_VERIFIED',
        'Подтвердите почту.',
        403,
      );
      expect(m, contains('Подтвердите'));
    });

    test('дневной лимит сообщает про сутки', () async {
      final m = await messageFor(
        'EDIT_PLAN_LIMIT_REACHED',
        'Дневной лимит запросов к AI исчерпан: 10 в сутки.',
        429,
      );
      expect(m, contains('лимит'));
    });

    test('провал App Check предлагает обновить страницу', () async {
      final m = await messageFor(
        'APP_CHECK_FAILED',
        'Отклонено проверкой.',
        403,
      );
      expect(m, contains('Обновите страницу'));
    });

    test('тело не по контракту — сообщение по статусу', () async {
      final service = _service(
        _Tokens(),
        // Тот же charset: кириллица в теле иначе не переживёт кодирование.
        (_) async => http.Response(
          '<html>прокси</html>',
          401,
          headers: {'content-type': 'text/html; charset=utf-8'},
        ),
      );
      try {
        await service.createEditPlan(_request());
        fail('ожидалась ошибка');
      } on AiEditingException catch (e) {
        expect(e.message, contains('Войдите'));
      }
    });
  });
}
