import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../core/app_config.dart';
import '../models/edit_plan.dart';
import 'ai_editing_service.dart' show AiEditingException;
import 'render_api_client.dart' show AuthTokens;

/// Статус анализа материалов (§4C.6) — то, что отдаёт `GET /analysis/{id}`.
class AnalysisStatus {
  const AnalysisStatus({
    required this.analysisId,
    required this.status,
    required this.phase,
    required this.progress,
    this.message = '',
    this.error,
  });

  final String analysisId;
  final String status; // queued | running | succeeded | failed | cancelled
  final String phase;
  final double progress;
  final String message;
  final String? error;

  bool get isTerminal =>
      status == 'succeeded' || status == 'failed' || status == 'cancelled';
  bool get isSucceeded => status == 'succeeded';

  static AnalysisStatus fromJson(Map<String, dynamic> json) {
    final a = (json['analysis'] as Map?)?.cast<String, dynamic>() ?? json;
    return AnalysisStatus(
      analysisId: a['analysisId'] as String? ?? '',
      status: a['status'] as String? ?? 'queued',
      phase: a['phase'] as String? ?? 'queued',
      progress: (a['progress'] as num?)?.toDouble() ?? 0,
      message: a['message'] as String? ?? '',
      error: (a['error'] as Map?)?['message'] as String?,
    );
  }
}

/// HTTP-клиент analysis API беты (§4C.4): `/analysis*`, `/catalog`, `/usage`.
///
/// Ключ Gemini здесь не участвует — клиент общается только со своим beta
/// backend'ом. Токены Firebase Auth и App Check берутся ПЕРЕД каждым запросом.
class AnalysisApiClient {
  AnalysisApiClient({
    String? baseUrl,
    http.Client? client,
    this.tokens,
    this.timeout = AppConfig.requestTimeout,
  }) : _baseUrl = _normalize(baseUrl ?? AppConfig.betaBackendBaseUrl),
       _client = client ?? http.Client(),
       _ownsClient = client == null;

  final String _baseUrl;
  final http.Client _client;
  final bool _ownsClient;
  final Duration timeout;
  final AuthTokens? tokens;

  static String _normalize(String v) =>
      v.endsWith('/') ? v.substring(0, v.length - 1) : v;

  bool get isConfigured => _baseUrl.isNotEmpty;

  Uri _uri(String path, [Map<String, String>? query]) =>
      Uri.parse('$_baseUrl$path').replace(queryParameters: query);

  /// Свежие токены на каждый запрос (§4C.5): ID token живёт час.
  Future<Map<String, String>> _headers({bool json = true, String? idem}) async {
    final headers = <String, String>{
      if (json) 'Content-Type': 'application/json',
      'Accept': 'application/json',
      if (idem != null && idem.isNotEmpty) 'Idempotency-Key': idem,
    };
    final source = tokens;
    if (source == null) return headers;
    final results = await Future.wait([
      source.idToken(),
      source.appCheckToken(),
    ]);
    final id = results[0];
    final appCheck = results[1];
    if (id != null && id.isNotEmpty) headers['Authorization'] = 'Bearer $id';
    if (appCheck != null && appCheck.isNotEmpty) {
      headers['X-Firebase-AppCheck'] = appCheck;
    }
    return headers;
  }

  Object? _decode(http.Response resp) {
    if (resp.statusCode >= 400) throw AiEditingException(_messageFor(resp));
    if (resp.bodyBytes.isEmpty) return null;
    return jsonDecode(utf8.decode(resp.bodyBytes));
  }

  /// POST /analysis — создать анализ (идемпотентно). Возвращает id.
  Future<String> createAnalysis({
    required String projectId,
    required List<Map<String, Object?>> assets,
    String? idempotencyKey,
  }) async {
    final resp = await _client
        .post(
          _uri('/analysis'),
          headers: await _headers(idem: idempotencyKey),
          body: jsonEncode({'projectId': projectId, 'assets': assets}),
        )
        .timeout(timeout);
    final decoded = _decode(resp);
    final id = AnalysisStatus.fromJson(
      (decoded as Map).cast<String, dynamic>(),
    ).analysisId;
    if (id.isEmpty) {
      throw const AiEditingException('Сервер не вернул идентификатор анализа.');
    }
    return id;
  }

  /// GET /analysis/{id} — статус.
  Future<AnalysisStatus> getStatus(String analysisId) async {
    final resp = await _client
        .get(
          _uri('/analysis/$analysisId'),
          headers: await _headers(json: false),
        )
        .timeout(timeout);
    return AnalysisStatus.fromJson(
      (_decode(resp) as Map).cast<String, dynamic>(),
    );
  }

  /// POST /analysis/{id}/plan — собрать EditPlan v2 из готового анализа.
  Future<EditPlan> getPlan(
    String analysisId, {
    String prompt = '',
    List<Map<String, Object?>> operations = const [],
    int? targetDurationSeconds,
  }) async {
    final resp = await _client
        .post(
          _uri('/analysis/$analysisId/plan'),
          headers: await _headers(),
          body: jsonEncode({
            'prompt': prompt,
            'operations': operations,
            'targetDurationSeconds': ?targetDurationSeconds,
          }),
        )
        .timeout(timeout);
    final decoded = _decode(resp);
    final planJson = decoded is Map && decoded['plan'] != null
        ? decoded['plan']
        : decoded;
    if (planJson is! Map) {
      throw const AiEditingException('Сервер вернул некорректный план.');
    }
    try {
      return EditPlan.fromJson(planJson.cast<String, dynamic>());
    } on EditPlanFormatException catch (e) {
      // Контрактное несоответствие плана — понятная ошибка, а не type-cast crash.
      throw AiEditingException(
        'Сервер вернул план в неизвестном формате (${e.message}).',
      );
    }
  }

  /// GET /catalog — переходы, шрифты, лимиты для UI.
  Future<Map<String, dynamic>> catalog() async {
    final resp = await _client
        .get(_uri('/catalog'), headers: await _headers(json: false))
        .timeout(timeout);
    return ((_decode(resp) as Map?) ?? {}).cast<String, dynamic>();
  }

  /// GET /usage — остаток дневной квоты анализов.
  Future<Map<String, dynamic>> usage({String? projectId}) async {
    final resp = await _client
        .get(
          _uri('/usage', {'projectId': ?projectId}),
          headers: await _headers(json: false),
        )
        .timeout(timeout);
    return ((_decode(resp) as Map?) ?? {}).cast<String, dynamic>();
  }

  void close() {
    if (_ownsClient) _client.close();
  }

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
      // тело не по контракту
    }
    return switch (code) {
      'UNAUTHENTICATED' => 'Сессия истекла. Войдите в аккаунт заново.',
      'DAILY_LIMIT_REACHED' || 'PROJECT_LIMIT_REACHED' =>
        message ?? 'Дневной лимит анализов исчерпан. Обновится завтра.',
      'TOO_MANY_ACTIVE_ANALYSES' => 'Уже выполняется другой анализ.',
      'APP_CHECK_FAILED' => 'Запрос отклонён проверкой приложения.',
      _ =>
        message ??
            (resp.statusCode >= 500
                ? 'Сервер временно недоступен.'
                : 'Не удалось выполнить анализ.'),
    };
  }
}
