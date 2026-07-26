import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/router.dart';
import '../../core/app_config.dart';
import '../../core/theme.dart';
import '../../models/enums.dart';
import '../../shared/app_background.dart';
import '../../shared/app_logo.dart';
import '../../shared/premium_widgets.dart';
import '../../shared/reel_preview.dart';
import '../../state/providers.dart';

class OnboardingScreen extends ConsumerWidget {
  const OnboardingScreen({super.key});

  static const _benefits = [
    (Icons.auto_awesome_rounded, 'AI выбирает лучшие моменты'),
    (Icons.subtitles_rounded, 'Автоматические субтитры'),
    (Icons.graphic_eq_rounded, 'Монтаж под музыку'),
  ];

  Future<void> _startNew(BuildContext context, WidgetRef ref) async {
    final hasDraft = await ref.read(hasDraftProvider.future);
    if (hasDraft && context.mounted) {
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('Начать новый проект?'),
          content: const Text(
            'Текущий черновик будет удалён. Это действие нельзя отменить.',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('Отмена'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('Начать заново'),
            ),
          ],
        ),
      );
      if (confirmed != true) return;
    }
    final controller = ref.read(projectProvider.notifier);
    await controller.clearProject();
    controller.setStage(AppStage.upload);
    if (context.mounted) context.push(AppRoutes.upload);
  }

  Future<void> _resumeDraft(BuildContext context, WidgetRef ref) async {
    final controller = ref.read(projectProvider.notifier);
    await controller.loadDraft();
    if (!context.mounted) return;
    final stage = ref.read(projectProvider).stage;
    final hasPlan = ref.read(projectProvider).plan != null;
    final route = switch (stage) {
      AppStage.onboarding || AppStage.upload => AppRoutes.upload,
      AppStage.settings || AppStage.processing => AppRoutes.settings,
      AppStage.preview ||
      AppStage.editor ||
      AppStage.export => hasPlan ? AppRoutes.preview : AppRoutes.settings,
    };
    context.push(route);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final hasDraft = ref.watch(hasDraftProvider).value ?? false;

    return Scaffold(
      body: AppBackground(
        child: SafeArea(
          child: LayoutBuilder(
            builder: (context, constraints) {
              return SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(24, 16, 24, 24),
                child: ConstrainedBox(
                  constraints: BoxConstraints(
                    minHeight: constraints.maxHeight - 40,
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          const AppLogo(),
                          if (AppConfig.isDemoMode)
                            const InfoPill(
                              label: 'Demo',
                              icon: Icons.science_rounded,
                            ),
                        ],
                      ),
                      const SizedBox(height: 32),
                      Text(
                        'Преврати моменты\nв готовый Reels',
                        style: theme.textTheme.displaySmall,
                      ),
                      const SizedBox(height: 12),
                      Text(
                        'Загрузи видео и фото, опиши идею — Reelio AI соберёт '
                        'вертикальный ролик с субтитрами и музыкой.',
                        style: theme.textTheme.bodyLarge?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                      const SizedBox(height: 28),
                      Center(
                        child: ConstrainedBox(
                          constraints: const BoxConstraints(maxHeight: 320),
                          child: DemoReelSurface(
                            style: EditStyle.dynamicStyle,
                            caption: 'Твоя история за 30 секунд',
                            musicLabel: 'Energy',
                            badge: _DemoBadge(),
                          ),
                        ),
                      ),
                      const SizedBox(height: 28),
                      ..._benefits.map(
                        (b) => Padding(
                          padding: const EdgeInsets.only(bottom: 12),
                          child: _BenefitRow(icon: b.$1, text: b.$2),
                        ),
                      ),
                      const SizedBox(height: 12),
                      GradientButton(
                        label: 'Создать ролик',
                        icon: Icons.auto_awesome_rounded,
                        onPressed: () => _startNew(context, ref),
                      ),
                      if (hasDraft) ...[
                        const SizedBox(height: 8),
                        Center(
                          child: TextButton.icon(
                            onPressed: () => _resumeDraft(context, ref),
                            icon: const Icon(Icons.history_rounded),
                            label: const Text('Продолжить черновик'),
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              );
            },
          ),
        ),
      ),
    );
  }
}

class _BenefitRow extends StatelessWidget {
  const _BenefitRow({required this.icon, required this.text});
  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Row(
      children: [
        Container(
          width: 44,
          height: 44,
          decoration: BoxDecoration(
            color: scheme.secondaryContainer,
            borderRadius: BorderRadius.circular(14),
          ),
          child: Icon(icon, color: scheme.primary, size: 22),
        ),
        const SizedBox(width: 14),
        Expanded(
          child: Text(text, style: Theme.of(context).textTheme.titleMedium),
        ),
      ],
    );
  }
}

class _DemoBadge extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: AppColors.lime,
        borderRadius: BorderRadius.circular(10),
      ),
      child: const Text(
        'AI',
        style: TextStyle(
          color: AppColors.limeDark,
          fontWeight: FontWeight.w900,
          fontSize: 13,
        ),
      ),
    );
  }
}
