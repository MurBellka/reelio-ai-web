import 'package:flutter/material.dart';

import '../core/theme.dart';

/// Мягкий градиентный фон приложения с аккуратными цветовыми пятнами.
class AppBackground extends StatelessWidget {
  const AppBackground({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final isDark = scheme.brightness == Brightness.dark;
    return DecoratedBox(
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: isDark
              ? [AppColors.darkBackground, const Color(0xFF160F2E)]
              : [const Color(0xFFF7F5FE), AppColors.coolBackground],
        ),
      ),
      child: Stack(
        children: [
          Positioned(
            top: -120,
            right: -80,
            child: _Blob(
              color: scheme.primary.withValues(alpha: isDark ? 0.28 : 0.16),
              size: 320,
            ),
          ),
          Positioned(
            top: 180,
            left: -110,
            child: _Blob(
              color: AppColors.lime.withValues(alpha: isDark ? 0.14 : 0.20),
              size: 260,
            ),
          ),
          Positioned(
            bottom: -100,
            right: -60,
            child: _Blob(
              color: scheme.secondary.withValues(alpha: isDark ? 0.22 : 0.14),
              size: 300,
            ),
          ),
          child,
        ],
      ),
    );
  }
}

class _Blob extends StatelessWidget {
  const _Blob({required this.color, required this.size});
  final Color color;
  final double size;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        gradient: RadialGradient(colors: [color, color.withValues(alpha: 0)]),
      ),
    );
  }
}
