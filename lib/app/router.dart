import 'package:go_router/go_router.dart';

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
}

GoRouter createRouter() => GoRouter(
  initialLocation: AppRoutes.onboarding,
  routes: [
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
