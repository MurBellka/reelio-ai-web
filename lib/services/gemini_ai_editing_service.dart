import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../core/app_config.dart';
import '../models/edit_plan.dart';
import '../models/edit_request.dart';
import 'ai_editing_service.dart';
import 'gemini_plan_parser.dart';
import 'render_api_client.dart' show AuthTokens;

/// Реальный планировщик монтажа через защищённый backend, который вызывает
/// Gemini. Gemini возвращает строго типизированный JSON-план, а видео собирает
/// FFmpeg-воркер на сервере — здесь только план.
///
/// Ключ Gemini **никогда** не хранится в клиенте: клиент общается только со
/// своим backend'ом по HTTPS.
class GeminiAiEditingService implements AiEditingService {
  GeminiAiEditingService({
    String? baseUrl,
    http.Client? client,
    this.tokens,
    this.timeout = AppConfig.requestTimeout,
    this.maxRetries = AppConfig.maxRetries,
    this.minInterval = AppConfig.minRequestInterval,
  }) : _baseUrl = baseUrl ?? AppConfig.activeBackendUrl,
       _client = client ?? http.Client();

  /// Источник токенов. `/edit-plan` защищён так же, как остальной API:
  /// без входа он отвечает 401, и запрос до Gemini просто не доходит.
  final AuthTokens? tokens;

  final String _baseUrl;
  http.Client _client;
  final Duration timeout;
  final int maxRetries;
  final Duration minInterval;

  DateTime? _lastRequest;
  bool _cancelled = false;

  @override
  bool get isDemo => false;

  @override
  void cancel() {
    _cancelled = true;
    _client.close();
    _client = http.Client();
  }

  @override
  Future<EditPlan> createEditPlan(
    EditRequest request, {
    ProcessingReporter? onProgress,
  }) async {
    // v1 не грузит исходники отдельно (их отправляет сам /edit-plan) — сообщаем
    // экрану обработки этап анализа.
    onProgress?.call(
      const ProcessingProgress.analyzing(
        analysisPhase: 'analyzing',
        analysisMessage: 'AI собирает монтажный план',
      ),
    );
    // Клиентский rate limit.
    final last = _lastRequest;
    if (last != null && DateTime.now().difference(last) < minInterval) {
      throw const AiEditingException(
        'Слишком часто. Подождите пару секунд и попробуйте снова.',
      );
    }
    _lastRequest = DateTime.now();
    _cancelled = false;

    final uri = Uri.parse('$_baseUrl/edit-plan');
    final body = jsonEncode(request.toJson());

    Object? lastError;
    for (var attempt = 0; attempt <= maxRetries; attempt++) {
      if (_cancelled) {
        throw const AiEditingException('Запрос отменён.');
      }
      try {
        // Токены берём ПЕРЕД КАЖДОЙ попыткой, а не один раз в конструкторе:
        // ID token живёт час, и при повторе после долгого ожидания старый
        // мог бы уже протухнуть.
        final resp = await _client
            .post(uri, headers: await _headers(), body: body)
            .timeout(timeout);

        if (resp.statusCode == 200) {
          final decoded = jsonDecode(utf8.decode(resp.bodyBytes));
          final planJson = decoded is Map && decoded['plan'] != null
              ? decoded['plan']
              : decoded;
          return parseGeminiPlan(planJson, request: request);
        }

        if (resp.statusCode >= 500) {
          lastError = AiEditingException(_messageFor(resp));
          await _backoff(attempt);
          continue; // повтор только для временных ошибок
        }
        // 4xx — постоянная ошибка, без повтора. Сообщение берём из конверта
        // backend'а: «сервер отклонил запрос» не подсказывает, что делать.
        throw AiEditingException(_messageFor(resp));
      } on AiEditingException {
        rethrow;
      } on TimeoutException {
        lastError = const AiEditingException(
          'Превышено время ожидания ответа. Попробуйте ещё раз.',
        );
        await _backoff(attempt);
      } catch (_) {
        lastError = const AiEditingException(
          'Нет связи с сервером. Проверьте подключение.',
        );
        await _backoff(attempt);
      }
    }
    throw lastError is AiEditingException
        ? lastError
        : const AiEditingException('Не удалось создать монтажный план.');
  }

  /// Заголовки запроса. Оба токена независимы: первый отвечает «кто это»,
  /// второй — «наше ли это приложение».
  Future<Map<String, String>> _headers() async {
    final headers = <String, String>{'Content-Type': 'application/json'};
    final source = tokens;
    if (source == null) return headers;

    final results = await Future.wait([
      source.idToken(),
      source.appCheckToken(),
    ]);
    final id = results[0];
    final appCheck = results[1];
    if (id != null && id.isNotEmpty) headers['Authorization'] = 'Bearer $id';
    // App Check добавляем только если он получен: его отсутствие не должно
    // ломать сценарий, backend в режиме наблюдения такой запрос пропустит.
    if (appCheck != null && appCheck.isNotEmpty) {
      headers['X-Firebase-AppCheck'] = appCheck;
    }
    return headers;
  }

  /// Человеческое сообщение по конверту ошибки контракта (§7).
  ///
  /// Общая фраза «Сервер отклонил запрос» не подсказывает, что делать:
  /// подтвердить почту, войти заново или дождаться следующих суток — это
  /// совершенно разные действия пользователя.
  static String _messageFor(http.Response resp) {
    String? code;
    String? message;
    try {
      final decoded = jsonDecode(utf8.decode(resp.bodyBytes));
      if (decoded is Map && decoded['error'] is Map) {
        final error = (decoded['error'] as Map).cast<String, dynamic>();
        code = error['code'] as String?;
        message = error['message'] as String?;
      }
    } catch (_) {
      // Тело не по контракту — решаем по статусу ниже.
    }

    switch (code) {
      case 'UNAUTHENTICATED':
        return 'Сессия истекла. Войдите в аккаунт заново.';
      case 'EMAIL_NOT_VERIFIED':
        return 'Подтвердите адрес электронной почты, чтобы создавать ролики.';
      case 'EDIT_PLAN_LIMIT_REACHED':
        return message ??
            'Дневной лимит запросов к AI исчерпан. Обновится завтра.';
      case 'APP_CHECK_FAILED':
        return 'Запрос отклонён проверкой приложения. Обновите страницу.';
      case 'RATE_LIMITED':
        return 'Слишком много запросов. Попробуйте через минуту.';
      case 'UPSTREAM_FAILED':
        return 'AI временно недоступен. Попробуйте ещё раз.';
    }

    // Кода нет — ориентируемся на статус.
    if (resp.statusCode == 401) {
      return 'Войдите в аккаунт, чтобы создать план.';
    }
    if (resp.statusCode == 403) {
      return 'Недостаточно прав для этого действия.';
    }
    if (resp.statusCode == 429) {
      return 'Слишком много запросов. Попробуйте позже.';
    }
    if (resp.statusCode >= 500) {
      return 'Сервер временно недоступен.';
    }
    return message ?? 'Не удалось создать монтажный план.';
  }

  Future<void> _backoff(int attempt) async {
    if (attempt >= maxRetries) return;
    final ms = 400 * (1 << attempt); // экспоненциально: 400, 800, …
    await Future<void>.delayed(Duration(milliseconds: ms));
  }
}
