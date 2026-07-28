import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/router.dart';
import '../../core/formatters.dart';
import '../../core/theme.dart';
import '../../models/edit_plan.dart';
import '../../models/enums.dart';
import '../../models/media_asset.dart';
import '../../shared/profile_button.dart';
import '../../shared/app_background.dart';
import '../../shared/premium_widgets.dart';
import '../../shared/stage_progress.dart';
import '../../state/providers.dart';
import 'montage_player.dart';

class PreviewScreen extends ConsumerStatefulWidget {
  const PreviewScreen({super.key});

  @override
  ConsumerState<PreviewScreen> createState() => _PreviewScreenState();
}

class _PreviewScreenState extends ConsumerState<PreviewScreen> {
  @override
  Widget build(BuildContext context) {
    final project = ref.watch(projectProvider);
    final plan = project.plan;

    if (plan == null) {
      return const Scaffold(
        body: Center(child: Text('Монтажный план ещё не готов.')),
      );
    }

    final total = plan.computedDuration;
    final assetsByPath = <String, MediaAsset>{
      for (final a in project.assets) a.path: a,
    };

    return Scaffold(
      appBar: AppBar(
        title: const Text('Предпросмотр'),
        actions: const [ProfileButton()],
      ),
      extendBodyBehindAppBar: true,
      body: AppBackground(
        child: SafeArea(
          child: Column(
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 8, 20, 0),
                child: StageProgress(current: AppStage.preview),
              ),
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(20, 16, 20, 12),
                  children: [
                    Center(
                      child: ConstrainedBox(
                        constraints: const BoxConstraints(maxHeight: 440),
                        child: MontagePlayer(
                          plan: plan,
                          assetsByPath: assetsByPath,
                          badge: const _DemoTag(),
                        ),
                      ),
                    ),
                    const SizedBox(height: 12),
                    _ReadyCard(plan: plan),
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        Expanded(
                          child: _InfoTile(
                            icon: plan.style.icon,
                            label: 'Стиль',
                            value: plan.style.label,
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: _InfoTile(
                            icon: Icons.timer_outlined,
                            label: 'Длительность',
                            value: Formatters.durationHuman(total),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        Expanded(
                          child: _InfoTile(
                            icon: plan.audio.keepOriginal
                                ? Icons.volume_up_rounded
                                : Icons.volume_off_rounded,
                            label: 'Звук',
                            value: plan.audio.keepOriginal
                                ? 'Оригинал'
                                : 'Без звука',
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: _InfoTile(
                            icon: Icons.movie_filter_rounded,
                            label: 'Сцен',
                            value: '${plan.clips.length}',
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
              _PreviewActions(
                onExport: () {
                  ref.read(projectProvider.notifier).setStage(AppStage.export);
                  context.push(AppRoutes.export);
                },
                onEdit: () {
                  ref.read(projectProvider.notifier).setStage(AppStage.editor);
                  context.push(AppRoutes.editor);
                },
                onRegenerate: () {
                  ref
                      .read(projectProvider.notifier)
                      .setStage(AppStage.processing);
                  context.pushReplacement(AppRoutes.processing);
                },
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ReadyCard extends StatelessWidget {
  const _ReadyCard({required this.plan});
  final EditPlan plan;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SoftCard(
      color: theme.colorScheme.primaryContainer,
      child: Row(
        children: [
          Container(
            width: 44,
            height: 44,
            decoration: const BoxDecoration(
              color: AppColors.lime,
              shape: BoxShape.circle,
            ),
            child: const Icon(Icons.check_rounded, color: AppColors.limeDark),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Ваш ролик готов', style: theme.textTheme.titleMedium),
                Text(
                  'Демонстрационный предпросмотр монтажа',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _InfoTile extends StatelessWidget {
  const _InfoTile({
    required this.icon,
    required this.label,
    required this.value,
  });
  final IconData icon;
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SoftCard(
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: theme.colorScheme.primary, size: 22),
          const SizedBox(height: 8),
          Text(
            label,
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          Text(value, style: theme.textTheme.titleMedium),
        ],
      ),
    );
  }
}

class _DemoTag extends StatelessWidget {
  const _DemoTag();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.45),
        borderRadius: BorderRadius.circular(8),
      ),
      child: const Text(
        'ДЕМО',
        style: TextStyle(
          color: Colors.white,
          fontWeight: FontWeight.w800,
          fontSize: 11,
          letterSpacing: 1,
        ),
      ),
    );
  }
}

class _PreviewActions extends StatelessWidget {
  const _PreviewActions({
    required this.onExport,
    required this.onEdit,
    required this.onRegenerate,
  });
  final VoidCallback onExport;
  final VoidCallback onEdit;
  final VoidCallback onRegenerate;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 4, 20, 12),
      child: Column(
        children: [
          GradientButton(
            label: 'Экспортировать',
            icon: Icons.ios_share_rounded,
            onPressed: onExport,
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: onEdit,
                  icon: const Icon(Icons.tune_rounded),
                  label: const Text('Внести правки'),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: onRegenerate,
                  icon: const Icon(Icons.refresh_rounded),
                  label: const Text('Создать заново'),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
