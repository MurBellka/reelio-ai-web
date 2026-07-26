import 'package:flutter/material.dart';

import '../core/theme.dart';

/// Логотип Reelio AI: градиентная иконка + словесный знак.
class AppLogo extends StatelessWidget {
  const AppLogo({super.key, this.compact = false});

  final bool compact;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final mark = Container(
      width: compact ? 36 : 48,
      height: compact ? 36 : 48,
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [AppColors.purple, AppColors.deepPurple],
        ),
        borderRadius: BorderRadius.circular(compact ? 12 : 16),
        boxShadow: [
          BoxShadow(
            color: AppColors.deepPurple.withValues(alpha: 0.35),
            blurRadius: 16,
            offset: const Offset(0, 6),
          ),
        ],
      ),
      child: Icon(
        Icons.movie_creation_rounded,
        color: Colors.white,
        size: compact ? 20 : 26,
      ),
    );

    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        mark,
        SizedBox(width: compact ? 10 : 12),
        RichText(
          text: TextSpan(
            style:
                (compact
                        ? theme.textTheme.titleLarge
                        : theme.textTheme.headlineSmall)
                    ?.copyWith(fontWeight: FontWeight.w800),
            children: [
              TextSpan(
                text: 'Reelio ',
                style: TextStyle(color: theme.colorScheme.onSurface),
              ),
              const TextSpan(
                text: 'AI',
                style: TextStyle(color: AppColors.purple),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
