import 'dart:async';

import 'package:firebase_app_check/firebase_app_check.dart';
import 'package:firebase_auth/firebase_auth.dart';

/// Ошибка авторизации с текстом, который не стыдно показать пользователю.
class AuthException implements Exception {
  const AuthException(this.message, {this.code = 'unknown'});

  final String message;
  final String code;

  @override
  String toString() => message;
}

/// Данные вошедшего пользователя.
class AuthUser {
  const AuthUser({
    required this.uid,
    required this.email,
    required this.emailVerified,
  });

  final String uid;
  final String email;
  final bool emailVerified;

  /// Рендер доступен только подтверждённым: этого же требует backend.
  bool get canRender => emailVerified;
}

/// Регистрация, вход и токены для запросов к backend'у.
///
/// Класс намеренно тонкий: он не хранит состояние сценария, а только переводит
/// Firebase в понятия приложения и превращает коды ошибок в человеческий текст.
class AuthService {
  AuthService({FirebaseAuth? auth, FirebaseAppCheck? appCheck})
    : _auth = auth ?? FirebaseAuth.instance,
      _appCheck = appCheck ?? FirebaseAppCheck.instance;

  final FirebaseAuth _auth;
  final FirebaseAppCheck _appCheck;

  AuthUser? _map(User? user) {
    if (user == null) return null;
    return AuthUser(
      uid: user.uid,
      email: user.email ?? '',
      emailVerified: user.emailVerified,
    );
  }

  AuthUser? get currentUser => _map(_auth.currentUser);

  /// Поток изменений входа. `userChanges` (а не `authStateChanges`) нужен,
  /// чтобы экран подтверждения почты реагировал на смену `emailVerified`.
  Stream<AuthUser?> get changes => _auth.userChanges().map(_map);

  Future<AuthUser> register({
    required String email,
    required String password,
  }) async {
    try {
      final cred = await _auth.createUserWithEmailAndPassword(
        email: email.trim(),
        password: password,
      );
      // Письмо отправляем сразу: без подтверждения рендер всё равно не работает.
      await cred.user?.sendEmailVerification();
      return _map(cred.user)!;
    } on FirebaseAuthException catch (e) {
      throw AuthException(_messageFor(e), code: e.code);
    }
  }

  Future<AuthUser> signIn({
    required String email,
    required String password,
  }) async {
    try {
      final cred = await _auth.signInWithEmailAndPassword(
        email: email.trim(),
        password: password,
      );
      return _map(cred.user)!;
    } on FirebaseAuthException catch (e) {
      throw AuthException(_messageFor(e), code: e.code);
    }
  }

  Future<void> signOut() => _auth.signOut();

  Future<void> sendVerificationEmail() async {
    final user = _auth.currentUser;
    if (user == null) throw const AuthException('Сначала войдите в аккаунт.');
    if (user.emailVerified) return;
    try {
      await user.sendEmailVerification();
    } on FirebaseAuthException catch (e) {
      throw AuthException(_messageFor(e), code: e.code);
    }
  }

  /// Перечитывает пользователя с сервера — иначе `emailVerified` не обновится
  /// после перехода по ссылке из письма.
  Future<bool> refreshVerification() async {
    final user = _auth.currentUser;
    if (user == null) return false;
    await user.reload();
    return _auth.currentUser?.emailVerified ?? false;
  }

  Future<void> sendPasswordReset(String email) async {
    try {
      await _auth.sendPasswordResetEmail(email: email.trim());
    } on FirebaseAuthException catch (e) {
      throw AuthException(_messageFor(e), code: e.code);
    }
  }

  /// ID token для заголовка `Authorization`. `forceRefresh` не нужен: SDK сам
  /// обновляет токен, когда до истечения остаётся меньше пяти минут.
  Future<String?> idToken({bool forceRefresh = false}) async {
    final user = _auth.currentUser;
    if (user == null) return null;
    try {
      return await user.getIdToken(forceRefresh);
    } catch (_) {
      return null;
    }
  }

  /// App Check token. Его отсутствие не должно ломать сценарий: backend в
  /// режиме наблюдения пропустит запрос и лишь отметит это в логе.
  Future<String?> appCheckToken() async {
    try {
      return await _appCheck.getToken();
    } catch (_) {
      return null;
    }
  }

  /// Удаление учётной записи выполняет backend (он же чистит данные);
  /// клиенту остаётся закрыть сессию.
  Future<void> forgetSession() => _auth.signOut();

  static String _messageFor(FirebaseAuthException e) => switch (e.code) {
    'invalid-email' => 'Неверный адрес электронной почты.',
    'email-already-in-use' => 'Аккаунт с такой почтой уже существует. Войдите.',
    'weak-password' => 'Пароль слишком простой: нужно минимум 6 символов.',
    'user-disabled' => 'Аккаунт заблокирован.',
    'user-not-found' ||
    'wrong-password' ||
    'invalid-credential' => 'Неверная почта или пароль.',
    'too-many-requests' => 'Слишком много попыток. Попробуйте позже.',
    'network-request-failed' => 'Нет связи. Проверьте подключение.',
    'requires-recent-login' => 'Для этого действия нужно войти заново.',
    _ => 'Не удалось выполнить действие. Попробуйте ещё раз.',
  };
}
