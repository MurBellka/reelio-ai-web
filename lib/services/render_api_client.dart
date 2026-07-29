import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart'
    show defaultTargetPlatform, kIsWeb, TargetPlatform;
import 'package:http/http.dart' as http;

import '../core/app_config.dart';
import '../models/render_job.dart';
import '../models/render_request.dart';
import '../models/upload_ticket.dart';

/// Источник токенов для запросов к backend'у.
///
/// Отдельный интерфейс, а не прямая зависимость от Firebase: клиент остаётся
/// тестируемым без инициализации Firebase в тестовой среде.
abstract class AuthTokens {
  Future<String?> idToken();
  Future<String?> appCheckToken();
}

/// Ошибка обращения к render API. Всегда несёт разобранный [RenderError]
/// контракта (§7) — UI показывает `message` и решает по `retryable`.
class RenderApiException implements Exception {
  const RenderApiException(this.error, {this.statusCode});

  final RenderError error;
  final int? statusCode;

  String get code => error.code;
  String get message => error.message;
  bool get retryable => error.retryable;

  @override
  String toString() => 'RenderApiException($statusCode, $error)';
}

/// Свежая ссылка на результат (`GET /download`, §8).
class RenderDownload {
  const RenderDownload({
    required this.downloadUrl,
    required this.fileName,
    this.expiresAt,
    this.sizeBytes,
  });

  final String downloadUrl;
  final String fileName;
  final DateTime? expiresAt;
  final int? sizeBytes;

  bool get isExpired {
    final expires = expiresAt;
    if (expires == null) return false;
    return !expires.isAfter(DateTime.now().toUtc());
  }
}

/// HTTP-клиент render API (`docs/render-contract.md`, §8).
///
/// Клиент не знает ни про Cloud Storage, ни про Cloud Run: он общается только
/// со своим backend'ом, а байты материалов отправляет напрямую по выданным
/// signed URLs.
class RenderApiClient {
  RenderApiClient({
    String? baseUrl,
    http.Client? client,
    this.timeout = AppConfig.requestTimeout,
    this.maxRetries = AppConfig.maxRetries,
    this.appVersion = '1.0.0',
    this.tokens,
  }) : _baseUrl = _normalizeBase(baseUrl ?? AppConfig.activeBackendUrl),
       _client = client ?? http.Client(),
       _ownsClient = client == null;

  /// Источник токенов для каждого запроса.
  ///
  /// Токены берутся заново перед отправкой, а не кэшируются в клиенте: ID token
  /// живёт час и обновляется SDK, и закешированный протух бы посреди сессии.
  final AuthTokens? tokens;

  final String _baseUrl;
  final http.Client _client;
  final bool _ownsClient;

  final Duration timeout;

  /// Количество повторов для временных ошибок (сеть, таймаут, 5xx, 429).
  final int maxRetries;

  final String appVersion;

  /// ETag последнего ответа `GET /jobs/{id}` — для дешёвого поллинга (§8).
  final Map<String, String> _jobEtags = {};
  final Map<String, RenderJob> _jobCache = {};

  static String _normalizeBase(String value) =>
      value.endsWith('/') ? value.substring(0, value.length - 1) : value;

  bool get isConfigured => _baseUrl.isNotEmpty;

  /// `flutter/1.0.0 (web)` — заголовок `X-Reelio-Client` из §3.
  String get clientHeader => 'flutter/$appVersion (${_platformTag()})';

  static String _platformTag() {
    if (kIsWeb) return 'web';
    return switch (defaultTargetPlatform) {
      TargetPlatform.iOS => 'ios',
      TargetPlatform.android => 'android',
      TargetPlatform.macOS => 'macos',
      TargetPlatform.windows => 'windows',
      TargetPlatform.linux => 'linux',
      TargetPlatform.fuchsia => 'fuchsia',
    };
  }

  /// Синхронные заголовки без авторизации (для запросов без токенов).
  Map<String, String> _headers({
    bool json = true,
    String? idempotencyKey,
    String? ifNoneMatch,
  }) => {
    if (json) 'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-Reelio-Client': clientHeader,
    if (idempotencyKey != null && idempotencyKey.isNotEmpty)
      'Idempotency-Key': idempotencyKey,
    'If-None-Match': ?ifNoneMatch,
  };

  /// Заголовки с токенами. Firebase ID token отвечает «кто это», App Check —
  /// «наше ли это приложение»; backend проверяет их независимо.
  Future<Map<String, String>> _authHeaders({
    bool json = true,
    String? idempotencyKey,
    String? ifNoneMatch,
  }) async {
    final base = _headers(
      json: json,
      idempotencyKey: idempotencyKey,
      ifNoneMatch: ifNoneMatch,
    );
    final source = tokens;
    if (source == null) return base;

    final results = await Future.wait([
      source.idToken(),
      source.appCheckToken(),
    ]);
    final id = results[0];
    final appCheck = results[1];
    return {
      ...base,
      if (id != null && id.isNotEmpty) 'Authorization': 'Bearer $id',
      if (appCheck != null && appCheck.isNotEmpty)
        'X-Firebase-AppCheck': appCheck,
    };
  }

  Uri _uri(String path, [Map<String, String>? query]) =>
      Uri.parse('$_baseUrl$path').replace(queryParameters: query);

  /// Ссылка для `<a download>` на web: сервер сам редиректит на signed URL.
  Uri downloadRedirectUri(String jobId) =>
      _uri('/download', {'jobId': jobId, 'redirect': '1'});

  // --- Загрузка материалов -------------------------------------------------

  /// Запрашивает signed URLs для прямой загрузки материалов в бакет.
  ///
  /// Эндпоинт `POST /uploads` — точка расширения контракта v1: сам контракт
  /// описывает пути объектов (§6), но не выдачу ссылок на запись. Клиент
  /// отправляет намерение и получает по разрешению на каждый материал.
  Future<List<UploadTicket>> requestUploadTickets({
    required String projectId,
    required List<RenderAsset> assets,
    required Map<String, String> contentTypes,
  }) async {
    final body = jsonEncode({
      'contractVersion': kRenderContractVersion,
      'projectId': projectId,
      'assets': [
        for (final asset in assets)
          {
            'id': asset.id,
            'type': asset.type.storageValue,
            'objectPath': asset.objectPath,
            if (asset.sizeBytes != null) 'sizeBytes': asset.sizeBytes,
            'contentType': contentTypes[asset.id] ?? 'application/octet-stream',
          },
      ],
    });

    final decoded = await _send(
      () async => _client.post(
        _uri('/uploads'),
        headers: await _authHeaders(),
        body: body,
      ),
    );
    final raw = decoded is Map
        ? (decoded['uploads'] ?? decoded['tickets'])
        : decoded;
    if (raw is! List) {
      throw RenderApiException(
        RenderError.local(
          'Сервер не выдал ссылки для загрузки материалов.',
          retryable: true,
        ),
      );
    }
    final tickets = raw
        .map(UploadTicket.tryParse)
        .whereType<UploadTicket>()
        .toList();
    if (tickets.length != assets.length) {
      throw RenderApiException(
        RenderError.local(
          'Сервер выдал ссылки не на все материалы. Попробуйте ещё раз.',
          retryable: true,
        ),
      );
    }
    return tickets;
  }

  // --- Задача рендера ------------------------------------------------------

  /// `POST /render` — создаёт задачу (202) либо возвращает существующую (200).
  Future<RenderJob> submitRender(RenderRequest request) async {
    final decoded = await _send(
      () async => _client.post(
        _uri('/render'),
        headers: await _authHeaders(idempotencyKey: request.idempotencyKey),
        body: jsonEncode(request.toJson()),
      ),
    );
    return _asJob(decoded);
  }

  /// `GET /jobs/{id}` с поддержкой `If-None-Match`: на `304` возвращается
  /// закэшированное состояние без разбора тела.
  Future<RenderJob> fetchJob(String jobId) async {
    final cached = _jobCache[jobId];
    final etag = _jobEtags[jobId];

    final response = await _sendRaw(
      () async => _client.get(
        _uri('/jobs/$jobId'),
        headers: await _authHeaders(
          json: false,
          ifNoneMatch: cached != null ? etag : null,
        ),
      ),
    );

    if (response.statusCode == 304 && cached != null) return cached;

    final decoded = _decodeOrThrow(response);
    final job = _asJob(decoded);
    final newEtag = response.headers['etag'];
    if (newEtag != null && newEtag.isNotEmpty) {
      _jobEtags[jobId] = newEtag;
    } else {
      _jobEtags.remove(jobId);
    }
    _jobCache[jobId] = job;
    return job;
  }

  /// `POST /jobs/{id}/cancel` — кооперативная отмена, идемпотентна.
  ///
  /// `409 JOB_ALREADY_TERMINAL` не считается ошибкой сценария: задача уже
  /// завершена, поэтому возвращается её актуальное состояние.
  Future<RenderJob> cancelJob(String jobId) async {
    try {
      final decoded = await _send(
        () async => _client.post(
          _uri('/jobs/$jobId/cancel'),
          headers: await _authHeaders(),
        ),
        retry: false,
      );
      final job = _asJob(decoded);
      _jobCache[jobId] = job;
      return job;
    } on RenderApiException catch (e) {
      if (e.code == 'JOB_ALREADY_TERMINAL') return fetchJob(jobId);
      rethrow;
    }
  }

  /// `GET /download?jobId=…` — всегда свежий signed URL (кэшировать нельзя).
  Future<RenderDownload> fetchDownload(String jobId) async {
    final decoded = await _send(
      () async => _client.get(
        _uri('/download', {'jobId': jobId}),
        headers: await _authHeaders(json: false),
      ),
    );
    if (decoded is! Map) {
      throw RenderApiException(
        RenderError.local('Сервер вернул некорректный ответ на /download.'),
      );
    }
    final url = decoded['downloadUrl'];
    if (url is! String || url.isEmpty) {
      throw RenderApiException(
        RenderError.local('Сервер не вернул ссылку на готовый MP4.'),
      );
    }
    return RenderDownload(
      downloadUrl: url,
      fileName: decoded['fileName'] as String? ?? 'reelio.mp4',
      expiresAt: DateTime.tryParse(
        decoded['expiresAt'] as String? ?? '',
      )?.toUtc(),
      sizeBytes: (decoded['sizeBytes'] as num?)?.toInt(),
    );
  }

  void forgetJob(String jobId) {
    _jobEtags.remove(jobId);
    _jobCache.remove(jobId);
  }

  void close() {
    if (_ownsClient) _client.close();
  }

  // --- Транспорт -----------------------------------------------------------

  RenderJob _asJob(Object? decoded) {
    if (decoded is! Map) {
      throw RenderApiException(
        RenderError.local('Сервер вернул некорректное состояние задачи.'),
      );
    }
    final json = decoded.cast<String, dynamic>();
    final job = RenderJob.fromJson(json);
    if (job.jobId.isEmpty) {
      throw RenderApiException(
        RenderError.local('Сервер не вернул идентификатор задачи рендера.'),
      );
    }
    return job;
  }

  /// Выполняет запрос с повторами по временным ошибкам и разбирает тело.
  Future<Object?> _send(
    Future<http.Response> Function() send, {
    bool retry = true,
  }) async {
    final response = await _sendRaw(send, retry: retry);
    return _decodeOrThrow(response);
  }

  Future<http.Response> _sendRaw(
    Future<http.Response> Function() send, {
    bool retry = true,
  }) async {
    if (!isConfigured) {
      throw RenderApiException(
        RenderError.local(
          'Рендер не настроен: не задан адрес backend.',
          retryable: false,
        ),
      );
    }

    final attempts = retry ? maxRetries : 0;
    RenderApiException? lastError;

    for (var attempt = 0; attempt <= attempts; attempt++) {
      try {
        final response = await send().timeout(timeout);
        if (response.statusCode < 400 || response.statusCode == 304) {
          return response;
        }
        final failure = _errorOf(response);
        if (!failure.retryable || attempt == attempts) throw failure;
        lastError = failure;
      } on RenderApiException {
        rethrow;
      } on TimeoutException {
        lastError = RenderApiException(
          RenderError.local(
            'Превышено время ожидания ответа сервера.',
            retryable: true,
          ),
        );
        if (attempt == attempts) throw lastError;
      } catch (_) {
        lastError = RenderApiException(
          RenderError.local(
            'Нет связи с сервером. Проверьте подключение.',
            retryable: true,
          ),
        );
        if (attempt == attempts) throw lastError;
      }
      await _backoff(attempt);
    }

    throw lastError ??
        RenderApiException(RenderError.local('Не удалось выполнить запрос.'));
  }

  Object? _decodeOrThrow(http.Response response) {
    if (response.statusCode >= 400) throw _errorOf(response);
    if (response.bodyBytes.isEmpty) return null;
    try {
      return jsonDecode(utf8.decode(response.bodyBytes));
    } catch (_) {
      throw RenderApiException(
        RenderError.local('Сервер вернул неразборчивый ответ.'),
        statusCode: response.statusCode,
      );
    }
  }

  RenderApiException _errorOf(http.Response response) {
    Object? decoded;
    try {
      decoded = response.bodyBytes.isEmpty
          ? null
          : jsonDecode(utf8.decode(response.bodyBytes));
    } catch (_) {
      decoded = null;
    }
    final parsed = RenderError.tryParse(decoded);
    if (parsed != null) {
      return RenderApiException(parsed, statusCode: response.statusCode);
    }
    // Ответ без конверта контракта: решаем по HTTP-статусу.
    final retryable =
        response.statusCode >= 500 ||
        response.statusCode == 429 ||
        response.statusCode == 408;
    return RenderApiException(
      RenderError(
        code: 'HTTP_${response.statusCode}',
        message: retryable
            ? 'Сервер временно недоступен. Попробуйте ещё раз.'
            : 'Сервер отклонил запрос рендера.',
        retryable: retryable,
      ),
      statusCode: response.statusCode,
    );
  }

  Future<void> _backoff(int attempt) async {
    final ms = 400 * (1 << attempt); // 400, 800, 1600 мс
    await Future<void>.delayed(Duration(milliseconds: ms));
  }
}
