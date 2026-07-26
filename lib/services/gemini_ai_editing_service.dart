import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../core/app_config.dart';
import '../models/edit_plan.dart';
import '../models/edit_request.dart';
import 'ai_editing_service.dart';
import 'gemini_plan_parser.dart';

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
    this.timeout = AppConfig.requestTimeout,
    this.maxRetries = AppConfig.maxRetries,
    this.minInterval = AppConfig.minRequestInterval,
  }) : _baseUrl = baseUrl ?? AppConfig.backendBaseUrl,
       _client = client ?? http.Client();

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
  Future<EditPlan> createEditPlan(EditRequest request) async {
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
        final resp = await _client
            .post(
              uri,
              headers: const {'Content-Type': 'application/json'},
              body: body,
            )
            .timeout(timeout);

        if (resp.statusCode == 200) {
          final decoded = jsonDecode(utf8.decode(resp.bodyBytes));
          final planJson = decoded is Map && decoded['plan'] != null
              ? decoded['plan']
              : decoded;
          return parseGeminiPlan(planJson, request: request);
        }

        if (resp.statusCode == 429) {
          throw const AiEditingException(
            'Слишком много запросов. Попробуйте позже.',
          );
        }
        if (resp.statusCode >= 500) {
          lastError = const AiEditingException('Сервер временно недоступен.');
          await _backoff(attempt);
          continue; // повтор только для временных ошибок
        }
        // 4xx — постоянная ошибка, без повтора.
        throw const AiEditingException('Сервер отклонил запрос на монтаж.');
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

  Future<void> _backoff(int attempt) async {
    if (attempt >= maxRetries) return;
    final ms = 400 * (1 << attempt); // экспоненциально: 400, 800, …
    await Future<void>.delayed(Duration(milliseconds: ms));
  }
}
