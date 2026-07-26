import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/router.dart';
import '../../core/formatters.dart';
import '../../core/theme.dart';
import '../../models/edit_plan.dart';
import '../../models/enums.dart';
import '../../models/media_asset.dart';
import '../../models/project_state.dart';
import '../../shared/app_background.dart';
import '../../shared/premium_widgets.dart';
import '../../shared/reel_preview.dart';
import '../../shared/stage_progress.dart';
import '../../state/providers.dart';

class PreviewScreen extends ConsumerStatefulWidget {
  const PreviewScreen({super.key});

  @override
  ConsumerState<PreviewScreen> createState() => _PreviewScreenState();
}

class _PreviewScreenState extends ConsumerState<PreviewScreen>
    with SingleTickerProviderStateMixin {
  late final AnimationController _playback;

  @override
  void initState() {
    super.initState();
    final plan = ref.read(projectProvider).plan;
    final seconds = (plan?.computedDuration ?? 15).clamp(1, 120).toDouble();
    _playback =
        AnimationController(
          vsync: this,
          duration: Duration(milliseconds: (seconds * 1000).round()),
        )..addStatusListener((s) {
          if (s == AnimationStatus.completed) {
            _playback.forward(from: 0); // цикличный демо-предпросмотр
          }
        });
  }

  @override
  void dispose() {
    _playback.dispose();
    super.dispose();
  }

  void _togglePlay() {
    setState(() {
      if (_playback.isAnimating) {
        _playback.stop();
      } else {
        _playback.forward(from: _playback.value >= 1.0 ? 0 : _playback.value);
      }
    });
  }

  MediaAsset? _coverAsset(ProjectState project, EditPlan plan) {
    final coverId = plan.coverClipId;
    final clip = coverId == null
        ? (plan.clips.isNotEmpty ? plan.clips.first : null)
        : plan.clips.where((c) => c.id == coverId).firstOrNull;
    if (clip == null) return null;
    return project.assets.where((a) => a.path == clip.filePath).firstOrNull;
  }

  @override
  Widget build(BuildContext context) {
    final project = ref.watch(projectProvider);
    final plan = project.plan;
    final theme = Theme.of(context);

    if (plan == null) {
      return const Scaffold(
        body: Center(child: Text('Монтажный план ещё не готов.')),
      );
    }

    final cover = _coverAsset(project, plan);
    final total = plan.computedDuration;

    return Scaffold(
      appBar: AppBar(title: const Text('Предпросмотр')),
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
                        constraints: const BoxConstraints(maxHeight: 420),
                        child: AnimatedBuilder(
                          animation: _playback,
                          builder: (context, _) => DemoReelSurface(
                            cover: cover,
                            style: plan.style,
                            caption: plan.captions.enabled
                                ? plan.captions.sampleText
                                : null,
                            captionColorHex: plan.captions.colorHex,
                            captionStyle: plan.captions.style,
                            musicLabel: plan.music.track.hasAudio
                                ? plan.music.track.label
                                : null,
                            showPlay: true,
                            isPlaying: _playback.isAnimating,
                            progress: _playback.value,
                            onTap: _togglePlay,
                            badge: const _DemoTag(),
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(height: 12),
                    AnimatedBuilder(
                      animation: _playback,
                      builder: (context, _) => Row(
                        children: [
                          IconButton.filledTonal(
                            onPressed: _togglePlay,
                            icon: Icon(
                              _playback.isAnimating
                                  ? Icons.pause_rounded
                                  : Icons.play_arrow_rounded,
                            ),
                          ),
                          Expanded(
                            child: Slider(
                              value: _playback.value.clamp(0.0, 1.0),
                              onChanged: (v) {
                                _playback.stop();
                                _playback.value = v;
                              },
                            ),
                          ),
                          Text(
                            '${Formatters.duration(_playback.value * total)} / ${Formatters.duration(total)}',
                            style: theme.textTheme.labelMedium,
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 8),
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
                            icon: plan.music.track.icon,
                            label: 'Музыка',
                            value: plan.music.track.label,
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
