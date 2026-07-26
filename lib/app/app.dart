import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../core/constants.dart';
import '../core/theme.dart';
import 'router.dart';

class ReelioApp extends StatefulWidget {
  const ReelioApp({super.key});

  @override
  State<ReelioApp> createState() => _ReelioAppState();
}

class _ReelioAppState extends State<ReelioApp> {
  late final GoRouter _router = createRouter();

  @override
  Widget build(BuildContext context) {
    return MaterialApp.router(
      title: AppConstants.appName,
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light(),
      darkTheme: AppTheme.dark(),
      themeMode: ThemeMode.system,
      routerConfig: _router,
      builder: (context, child) {
        // Поддержка Dynamic Type с разумным ограничением масштаба.
        final mq = MediaQuery.of(context);
        final clamped = mq.textScaler.clamp(
          minScaleFactor: 0.9,
          maxScaleFactor: 1.35,
        );
        return MediaQuery(
          data: mq.copyWith(textScaler: clamped),
          child: _CenteredShell(child: child!),
        );
      },
    );
  }
}

/// На широких экранах (десктоп/планшет) приложение показывается как
/// вертикальный телефонный контейнер по центру, а не растягивается на всю
/// ширину. На телефоне отдаётся как есть.
class _CenteredShell extends StatelessWidget {
  const _CenteredShell({required this.child});

  final Widget child;

  static const double _phoneWidth = 460;
  static const double _breakpoint = 640;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        if (constraints.maxWidth <= _breakpoint) return child;
        final isDark = Theme.of(context).brightness == Brightness.dark;
        return ColoredBox(
          color: isDark ? const Color(0xFF0B0819) : const Color(0xFFE7E4F5),
          child: Center(
            child: ClipRect(
              child: SizedBox(width: _phoneWidth, child: child),
            ),
          ),
        );
      },
    );
  }
}
