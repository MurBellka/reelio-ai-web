import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;

import '../core/app_config.dart';
import '../services/auth_service.dart';
import '../services/backend_version_service.dart';
import '../services/render_api_client.dart';

/// Мост между [AuthService] и API-клиентом: клиент не знает про Firebase.
class FirebaseAuthTokens implements AuthTokens {
  const FirebaseAuthTokens(this._auth);

  final AuthService _auth;

  @override
  Future<String?> idToken() => _auth.idToken();

  @override
  Future<String?> appCheckToken() => _auth.appCheckToken();
}

/// Проверка поколения API. Живёт всё время работы приложения: у неё свой
/// короткий кэш, повторное создание сбрасывало бы его на каждом экране.
final backendVersionServiceProvider = Provider<BackendVersionService>((ref) {
  final service = BackendVersionService();
  ref.onDispose(service.close);
  return service;
});

/// Готовность backend'а принимать материалы. Проверяется перед загрузкой и
/// перед рендером.
final backendStatusProvider = FutureProvider<BackendStatus>(
  (ref) => ref.watch(backendVersionServiceProvider).check(),
);

final authServiceProvider = Provider<AuthService>((ref) {
  final service = AuthService();
  ref.onDispose(() {});
  return service;
});

final authTokensProvider = Provider<AuthTokens>(
  (ref) => FirebaseAuthTokens(ref.watch(authServiceProvider)),
);

/// Текущий пользователь. `null` — не вошёл.
final authUserProvider = StreamProvider<AuthUser?>(
  (ref) => ref.watch(authServiceProvider).changes,
);

/// Готов ли пользователь пользоваться рендером: вошёл и подтвердил почту.
final canRenderProvider = Provider<bool>((ref) {
  final user = ref.watch(authUserProvider).value;
  return user != null && user.canRender;
});

/// Остаток кредитов и продуктовые лимиты — то, что показывает профиль.
class AccountUsage {
  const AccountUsage({
    required this.creditsRemaining,
    required this.creditsLimit,
    required this.editPlanRemaining,
    required this.editPlanLimit,
    required this.costs,
    required this.retentionDays,
    required this.maxOutputSeconds,
  });

  final int creditsRemaining;
  final int creditsLimit;
  final int editPlanRemaining;
  final int editPlanLimit;

  /// Стоимость рендера в кредитах по разрешению.
  final Map<String, int> costs;

  /// Сколько дней хранится готовый ролик.
  final int retentionDays;
  final int maxOutputSeconds;

  bool get exhausted => creditsRemaining <= 0;

  /// Хватит ли кредитов на конкретное разрешение.
  bool canAfford(String resolution) =>
      creditsRemaining >= (costs[resolution] ?? 1);

  static AccountUsage fromJson(Map<String, dynamic> json) {
    final usage = (json['usage'] as Map?)?.cast<String, dynamic>() ?? const {};
    final limits =
        (json['limits'] as Map?)?.cast<String, dynamic>() ?? const {};
    final costs = (usage['costs'] as Map?)?.cast<String, dynamic>() ?? const {};
    return AccountUsage(
      creditsRemaining: (usage['renderCreditsRemaining'] as num?)?.toInt() ?? 0,
      creditsLimit: (usage['renderCreditsLimit'] as num?)?.toInt() ?? 0,
      editPlanRemaining: (usage['editPlanRemaining'] as num?)?.toInt() ?? 0,
      editPlanLimit: (usage['editPlanLimit'] as num?)?.toInt() ?? 0,
      costs: {for (final e in costs.entries) e.key: (e.value as num).toInt()},
      retentionDays: (limits['retentionDays'] as num?)?.toInt() ?? 7,
      maxOutputSeconds: (limits['maxOutputSeconds'] as num?)?.toInt() ?? 120,
    );
  }
}

/// Клиент профиля и удаления данных.
class AccountApi {
  AccountApi({required this.tokens, http.Client? client, String? baseUrl})
    : _client = client ?? http.Client(),
      _baseUrl = (baseUrl ?? AppConfig.backendBaseUrl).replaceAll(
        RegExp(r'/+$'),
        '',
      );

  final AuthTokens tokens;
  final http.Client _client;
  final String _baseUrl;

  Future<Map<String, String>> _headers() async {
    final results = await Future.wait([
      tokens.idToken(),
      tokens.appCheckToken(),
    ]);
    final id = results[0];
    final appCheck = results[1];
    return {
      'Accept': 'application/json',
      if (id != null && id.isNotEmpty) 'Authorization': 'Bearer $id',
      if (appCheck != null && appCheck.isNotEmpty)
        'X-Firebase-AppCheck': appCheck,
    };
  }

  Future<AccountUsage> fetchUsage() async {
    final res = await _client.get(
      Uri.parse('$_baseUrl/me'),
      headers: await _headers(),
    );
    if (res.statusCode >= 400) {
      throw Exception('Не удалось получить данные аккаунта.');
    }
    return AccountUsage.fromJson(
      (jsonDecode(utf8.decode(res.bodyBytes)) as Map).cast<String, dynamic>(),
    );
  }

  /// Удаляет проект со всеми исходниками и результатами.
  Future<void> deleteProject(String projectId) async {
    final res = await _client.delete(
      Uri.parse('$_baseUrl/projects/$projectId'),
      headers: await _headers(),
    );
    if (res.statusCode >= 400) throw Exception('Не удалось удалить проект.');
  }

  /// Удаляет аккаунт и все пользовательские данные на сервере.
  Future<void> deleteAccount() async {
    final res = await _client.delete(
      Uri.parse('$_baseUrl/account'),
      headers: await _headers(),
    );
    if (res.statusCode >= 400) throw Exception('Не удалось удалить аккаунт.');
  }

  void close() => _client.close();
}

final accountApiProvider = Provider<AccountApi>((ref) {
  final api = AccountApi(tokens: ref.watch(authTokensProvider));
  ref.onDispose(api.close);
  return api;
});

/// Остаток кредитов. Перечитывается после каждого рендера и удаления.
final accountUsageProvider = FutureProvider<AccountUsage>((ref) async {
  // Без входа спрашивать нечего.
  final user = ref.watch(authUserProvider).value;
  if (user == null || !user.emailVerified) {
    throw StateError('Требуется подтверждённый вход.');
  }
  return ref.watch(accountApiProvider).fetchUsage();
});
