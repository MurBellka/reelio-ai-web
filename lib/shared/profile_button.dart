import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../app/router.dart';
import '../core/app_config.dart';
import '../state/auth_providers.dart';

/// Кнопка перехода в профиль для панели любого экрана.
///
/// Показывает остаток кредитов прямо на кнопке: это единственное число, за
/// которым пользователь следит в бете, и ради него не стоит заходить в профиль.
/// В демо-режиме без backend'а аккаунта нет — кнопка не появляется.
class ProfileButton extends ConsumerWidget {
  const ProfileButton({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (!AppConfig.hasBackend) return const SizedBox.shrink();

    final user = ref.watch(authUserProvider).value;
    if (user == null) return const SizedBox.shrink();

    final theme = Theme.of(context);
    final usage = ref.watch(accountUsageProvider);
    final credits = usage.value?.creditsRemaining;
    final exhausted = credits != null && credits <= 0;

    return Padding(
      padding: const EdgeInsets.only(right: 4),
      child: TextButton.icon(
        onPressed: () => context.push(AppRoutes.profile),
        // Достаточная площадь нажатия на телефоне.
        style: TextButton.styleFrom(
          minimumSize: const Size(48, 48),
          padding: const EdgeInsets.symmetric(horizontal: 12),
          foregroundColor: exhausted
              ? theme.colorScheme.error
              : theme.colorScheme.onSurface,
        ),
        icon: const Icon(Icons.account_circle_rounded),
        label: Text(
          credits == null ? 'Профиль' : '$credits',
          style: theme.textTheme.labelLarge?.copyWith(
            color: exhausted ? theme.colorScheme.error : null,
          ),
        ),
      ),
    );
  }
}
