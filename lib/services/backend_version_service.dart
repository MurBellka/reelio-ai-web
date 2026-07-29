import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../core/app_config.dart';

/// Поколение API, с которым умеет работать этот клиент.
///
/// Версия 2 требует входа. Старый backend признака не отдаёт вовсе, и это
/// главное различие: ответ у него валиден, просто без `apiVersion`.
const int kRequiredApiVersion = 2;

/// Готовность backend'а принимать материалы.
enum BackendReadiness {
  /// Версия совпадает — можно загружать и рендерить.
  ready,

  /// Backend отвечает, но старой версии: идёт переключение.
  updating,

  /// Backend недоступен: сеть, таймаут, 5xx.
  unreachable,
}

class BackendStatus {
  const BackendStatus({
    required this.readiness,
    this.apiVersion,
    this.authRequired,
  });

  final BackendReadiness readiness;
  final int? apiVersion;
  final bool? authRequired;

  bool get canSubmitWork => readiness == BackendReadiness.ready;

  static const BackendStatus unreachable = BackendStatus(
    readiness: BackendReadiness.unreachable,
  );
}

/// Проверяет, обновлён ли backend, прежде чем отправлять материалы.
///
/// Смысл проверки — не в диагностике, а в защите пользователя: старый и новый
/// API несовместимы по авторизации. Клиент, отправивший файлы на старый
/// backend, получил бы отказ уже ПОСЛЕ загрузки — потратив трафик и время.
class BackendVersionService {
  BackendVersionService({
    http.Client? client,
    String? baseUrl,
    this.timeout = const Duration(seconds: 8),
  }) : _client = client ?? http.Client(),
       _ownsClient = client == null,
       _baseUrl = (baseUrl ?? AppConfig.activeBackendUrl).replaceAll(
         RegExp(r'/+$'),
         '',
       );

  final http.Client _client;
  final bool _ownsClient;
  final String _baseUrl;
  final Duration timeout;

  /// Кэш на короткое время: проверка идёт перед каждой отправкой, и опрашивать
  /// сервис на каждое нажатие незачем. Окно намеренно небольшое, чтобы после
  /// переключения приложение подхватило новую версию без перезапуска.
  BackendStatus? _cached;
  DateTime? _cachedAt;
  static const Duration _cacheWindow = Duration(seconds: 30);

  Future<BackendStatus> check({bool force = false}) async {
    if (!force && _cached != null && _cachedAt != null) {
      if (DateTime.now().difference(_cachedAt!) < _cacheWindow) return _cached!;
    }
    final status = await _fetch();
    _cached = status;
    _cachedAt = DateTime.now();
    return status;
  }

  Future<BackendStatus> _fetch() async {
    if (_baseUrl.isEmpty) return BackendStatus.unreachable;
    try {
      final res = await _client
          .get(
            Uri.parse('$_baseUrl/health'),
            headers: {'Accept': 'application/json'},
          )
          .timeout(timeout);

      if (res.statusCode >= 400) return BackendStatus.unreachable;

      final body = jsonDecode(utf8.decode(res.bodyBytes));
      if (body is! Map) return BackendStatus.unreachable;

      final version = (body['apiVersion'] as num?)?.toInt();
      final authRequired = body['authRequired'] as bool?;

      // Признака нет — это старый backend, переключение ещё не завершилось.
      if (version == null || version < kRequiredApiVersion) {
        return BackendStatus(
          readiness: BackendReadiness.updating,
          apiVersion: version,
          authRequired: authRequired,
        );
      }
      return BackendStatus(
        readiness: BackendReadiness.ready,
        apiVersion: version,
        authRequired: authRequired,
      );
    } catch (_) {
      return BackendStatus.unreachable;
    }
  }

  void close() {
    if (_ownsClient) _client.close();
  }
}
