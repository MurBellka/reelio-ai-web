import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../state/auth_providers.dart';

import '../core/app_config.dart';
import '../features/auth/auth_screens.dart';
import '../features/auth/profile_screen.dart';
import '../features/editor/editor_screen.dart';
import '../features/edit_settings/edit_settings_screen.dart';
import '../features/export/export_screen.dart';
import '../features/media_upload/media_upload_screen.dart';
import '../features/onboarding/onboarding_screen.dart';
import '../features/preview/preview_screen.dart';
import '../features/processing/processing_screen.dart';

/// Именованные маршруты приложения.
class AppRoutes {
  const AppRoutes._();
  static const onboarding = '/';
  static const upload = '/upload';
  static const settings = '/settings';
  static const processing = '/processing';
  static const preview = '/preview';
  static const editor = '/editor';
  static const export = '/export';

  // Авторизация и аккаунт.
  static const signIn = '/sign-in';
  static const signUp = '/sign-up';
  static const verifyEmail = '/verify-email';
  static const resetPassword = '/reset-password';
  static const profile = '/profile';
  static const privacy = '/privacy';

  /// Маршруты, доступные без входа.
  static const publicRoutes = <String>{signIn, signUp, resetPassword, privacy};
}

/// Роутер как провайдер: так он получает настоящий [Ref] и живёт ровно
/// столько же, сколько контейнер состояния.
final routerProvider = Provider<GoRouter>((ref) => createRouter(ref));

GoRouter createRouter(Ref ref) => GoRouter(
  initialLocation: AppRoutes.onboarding,
  // Пересобираем маршрут при смене состояния входа: выход должен немедленно
  // уводить с защищённых экранов, а не ждать следующей навигации.
  refreshListenable: _AuthRefresh(ref),
  redirect: (context, state) {
    // Без backend'а приложение работает в демо-режиме и вход не требуется.
    if (!AppConfig.hasBackend) return null;

    final path = state.matchedLocation;
    if (AppRoutes.publicRoutes.contains(path)) return null;

    final auth = ref.read(authUserProvider);
    // Пока состояние не загрузилось, никуда не уводим — иначе на старте
    // мелькает экран входа у уже вошедшего пользователя.
    if (auth.isLoading) return null;

    final user = auth.value;
    if (user == null) return AppRoutes.signIn;
    // Подтверждение почты — обязательный шаг: рендер без него не работает.
    if (!user.emailVerified && path != AppRoutes.verifyEmail) {
      return AppRoutes.verifyEmail;
    }
    return null;
  },
  routes: [
    GoRoute(path: AppRoutes.signIn, builder: (_, _) => const SignInScreen()),
    GoRoute(path: AppRoutes.signUp, builder: (_, _) => const SignUpScreen()),
    GoRoute(
      path: AppRoutes.verifyEmail,
      builder: (_, _) => const VerifyEmailScreen(),
    ),
    GoRoute(
      path: AppRoutes.resetPassword,
      builder: (_, _) => const ResetPasswordScreen(),
    ),
    GoRoute(path: AppRoutes.profile, builder: (_, _) => const ProfileScreen()),
    GoRoute(path: AppRoutes.privacy, builder: (_, _) => const PrivacyScreen()),
    GoRoute(
      path: AppRoutes.onboarding,
      builder: (_, _) => const OnboardingScreen(),
    ),
    GoRoute(
      path: AppRoutes.upload,
      builder: (_, _) => const MediaUploadScreen(),
    ),
    GoRoute(
      path: AppRoutes.settings,
      builder: (_, _) => const EditSettingsScreen(),
    ),
    GoRoute(
      path: AppRoutes.processing,
      builder: (_, _) => const ProcessingScreen(),
    ),
    GoRoute(path: AppRoutes.preview, builder: (_, _) => const PreviewScreen()),
    GoRoute(path: AppRoutes.editor, builder: (_, _) => const EditorScreen()),
    GoRoute(path: AppRoutes.export, builder: (_, _) => const ExportScreen()),
  ],
);

/// Пробрасывает изменения входа в GoRouter.
class _AuthRefresh extends ChangeNotifier {
  _AuthRefresh(this._ref) {
    _sub = _ref.listen(authUserProvider, (_, _) => notifyListeners());
  }

  final Ref _ref;
  late final ProviderSubscription<Object?> _sub;

  @override
  void dispose() {
    _sub.close();
    super.dispose();
  }
}
