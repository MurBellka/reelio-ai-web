import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/formatters.dart';
import '../../core/theme.dart';
import '../../models/edit_plan.dart';
import '../../models/enums.dart';
import '../../models/media_asset.dart';
import '../../shared/profile_button.dart';
import '../../shared/app_background.dart';
import '../../shared/media_thumbnail.dart';
import '../../shared/premium_widgets.dart';
import '../../state/providers.dart';

const _captionColors = <(String, int)>[
  ('Белый', 0xFFFFFFFF),
  ('Лайм', 0xFFC4F82A),
  ('Фиолетовый', 0xFFC4B5FD),
  ('Жёлтый', 0xFFFFE066),
  ('Чёрный', 0xFF111111),
];

class EditorScreen extends ConsumerStatefulWidget {
  const EditorScreen({super.key});

  @override
  ConsumerState<EditorScreen> createState() => _EditorScreenState();
}

class _EditorScreenState extends ConsumerState<EditorScreen> {
  late final TextEditingController _captionController;

  @override
  void initState() {
    super.initState();
    _captionController = TextEditingController(
      text: ref.read(projectProvider).plan?.captions.sampleText ?? '',
    );
  }

  @override
  void dispose() {
    _captionController.dispose();
    super.dispose();
  }

  void _deleteClip(int index, EditPlan plan) {
    if (plan.clips.length <= 1) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('Нужен хотя бы один клип.')));
      return;
    }
    final removed = ref.read(projectProvider.notifier).removeClipAt(index);
    if (removed == null) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: const Text('Клип удалён'),
          action: SnackBarAction(
            label: 'Отменить',
            onPressed: () => ref
                .read(projectProvider.notifier)
                .restoreClip(removed.clip, removed.index),
          ),
        ),
      );
  }

  @override
  Widget build(BuildContext context) {
    final project = ref.watch(projectProvider);
    final plan = project.plan;
    final controller = ref.read(projectProvider.notifier);
    final theme = Theme.of(context);

    if (plan == null) {
      return const Scaffold(
        body: Center(child: Text('Нет плана для редактирования.')),
      );
    }

    final captions = plan.captions;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Правки'),
        actions: const [ProfileButton()],
      ),
      extendBodyBehindAppBar: true,
      body: AppBackground(
        child: SafeArea(
          child: Column(
            children: [
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(20, 12, 20, 16),
                  children: [
                    const SectionHeader(
                      title: 'Таймлайн',
                      subtitle: 'Перетащите, чтобы изменить порядок',
                    ),
                    const SizedBox(height: 12),
                    _Timeline(
                      plan: plan,
                      onReorder: controller.reorderClips,
                      onDelete: (i) => _deleteClip(i, plan),
                      onCover: (id) => controller.setCover(id),
                    ),
                    const SizedBox(height: 24),
                    const SectionHeader(title: 'Субтитры'),
                    const SizedBox(height: 8),
                    SoftCard(
                      child: Column(
                        children: [
                          Row(
                            children: [
                              Expanded(
                                child: Text(
                                  'Показывать субтитры',
                                  style: theme.textTheme.titleMedium,
                                ),
                              ),
                              Switch(
                                value: captions.enabled,
                                onChanged: (v) => controller.setPlanCaptions(
                                  captions.copyWith(enabled: v),
                                ),
                              ),
                            ],
                          ),
                          if (captions.enabled) ...[
                            const Divider(height: 24),
                            TextField(
                              controller: _captionController,
                              onChanged: (v) => controller.setPlanCaptions(
                                captions.copyWith(sampleText: v),
                              ),
                              maxLength: 120,
                              decoration: const InputDecoration(
                                labelText: 'Текст субтитра',
                                border: OutlineInputBorder(),
                              ),
                            ),
                            const SizedBox(height: 8),
                            Align(
                              alignment: Alignment.centerLeft,
                              child: Text(
                                'Стиль',
                                style: theme.textTheme.bodyMedium?.copyWith(
                                  color: theme.colorScheme.onSurfaceVariant,
                                ),
                              ),
                            ),
                            const SizedBox(height: 8),
                            Wrap(
                              spacing: 8,
                              children: [
                                for (final s in CaptionStyle.values)
                                  ChoiceChip(
                                    label: Text(s.label),
                                    selected: captions.style == s,
                                    onSelected: (_) =>
                                        controller.setPlanCaptions(
                                          captions.copyWith(style: s),
                                        ),
                                  ),
                              ],
                            ),
                            const SizedBox(height: 12),
                            Align(
                              alignment: Alignment.centerLeft,
                              child: Text(
                                'Цвет',
                                style: theme.textTheme.bodyMedium?.copyWith(
                                  color: theme.colorScheme.onSurfaceVariant,
                                ),
                              ),
                            ),
                            const SizedBox(height: 8),
                            Row(
                              children: [
                                for (final c in _captionColors)
                                  Padding(
                                    padding: const EdgeInsets.only(right: 12),
                                    child: _ColorSwatch(
                                      color: Color(c.$2),
                                      selected:
                                          captions.colorHex.toUpperCase() ==
                                          '#${(c.$2 & 0xFFFFFF).toRadixString(16).padLeft(6, '0').toUpperCase()}',
                                      onTap: () => controller.setPlanCaptions(
                                        captions.copyWith(
                                          colorHex:
                                              '#${(c.$2 & 0xFFFFFF).toRadixString(16).padLeft(6, '0').toUpperCase()}',
                                        ),
                                      ),
                                    ),
                                  ),
                              ],
                            ),
                          ],
                        ],
                      ),
                    ),
                    const SizedBox(height: 24),
                    const SectionHeader(title: 'Музыка'),
                    const SizedBox(height: 12),
                    Wrap(
                      spacing: 10,
                      runSpacing: 10,
                      children: [
                        for (final track in MusicTrack.values)
                          ChoiceChip(
                            avatar: Icon(track.icon, size: 18),
                            label: Text(track.label),
                            selected: plan.music.track == track,
                            onSelected: (_) => controller.setPlanMusic(
                              plan.music.copyWith(track: track),
                            ),
                          ),
                      ],
                    ),
                    if (plan.music.track.hasAudio) ...[
                      const SizedBox(height: 12),
                      SoftCard(
                        child: Row(
                          children: [
                            Icon(
                              Icons.volume_up_rounded,
                              color: theme.colorScheme.primary,
                            ),
                            Expanded(
                              child: Slider(
                                value: plan.music.volume,
                                onChanged: (v) => controller.setPlanMusic(
                                  plan.music.copyWith(volume: v),
                                ),
                              ),
                            ),
                            SizedBox(
                              width: 44,
                              child: Text(
                                '${(plan.music.volume * 100).round()}%',
                                textAlign: TextAlign.end,
                                style: theme.textTheme.labelLarge,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 4, 20, 12),
                child: Row(
                  children: [
                    Expanded(
                      child: OutlinedButton(
                        onPressed: () => Navigator.of(context).maybePop(),
                        child: const Text('К предпросмотру'),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      flex: 2,
                      child: GradientButton(
                        label: 'Сохранить',
                        icon: Icons.check_rounded,
                        onPressed: () {
                          ScaffoldMessenger.of(context).showSnackBar(
                            const SnackBar(
                              content: Text('Изменения сохранены'),
                            ),
                          );
                          Navigator.of(context).maybePop();
                        },
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Timeline extends StatelessWidget {
  const _Timeline({
    required this.plan,
    required this.onReorder,
    required this.onDelete,
    required this.onCover,
  });

  final EditPlan plan;
  final void Function(int, int) onReorder;
  final void Function(int) onDelete;
  final void Function(String) onCover;

  MediaAsset _assetOf(EditClip clip) => MediaAsset(
    id: clip.id,
    path: clip.filePath,
    name: clip.sourceName,
    type: clip.type,
    durationSeconds: clip.type == MediaType.video ? clip.duration : null,
  );

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SizedBox(
      height: 168,
      child: ReorderableListView.builder(
        scrollDirection: Axis.horizontal,
        buildDefaultDragHandles: false,
        padding: EdgeInsets.zero,
        itemCount: plan.clips.length,
        onReorderItem: onReorder,
        proxyDecorator: (child, _, _) =>
            Material(color: Colors.transparent, child: child),
        itemBuilder: (context, index) {
          final clip = plan.clips[index];
          final isCover = plan.coverClipId == clip.id;
          return Padding(
            key: ValueKey(clip.id),
            padding: const EdgeInsets.only(right: 12),
            child: ReorderableDragStartListener(
              index: index,
              child: SizedBox(
                width: 104,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: Stack(
                        children: [
                          Positioned.fill(
                            child: Container(
                              decoration: BoxDecoration(
                                borderRadius: BorderRadius.circular(
                                  AppRadius.sm,
                                ),
                                border: Border.all(
                                  color: isCover
                                      ? AppColors.lime
                                      : theme.colorScheme.outlineVariant,
                                  width: isCover ? 3 : 1,
                                ),
                              ),
                              child: MediaThumbnail(asset: _assetOf(clip)),
                            ),
                          ),
                          Positioned(
                            top: 4,
                            left: 4,
                            child: _MiniButton(
                              icon: isCover
                                  ? Icons.star_rounded
                                  : Icons.star_outline_rounded,
                              color: isCover ? AppColors.lime : Colors.white,
                              onTap: () => onCover(clip.id),
                            ),
                          ),
                          Positioned(
                            top: 4,
                            right: 4,
                            child: _MiniButton(
                              icon: Icons.close_rounded,
                              color: Colors.white,
                              onTap: () => onDelete(index),
                            ),
                          ),
                          Positioned(
                            left: 4,
                            bottom: 4,
                            child: Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 6,
                                vertical: 2,
                              ),
                              decoration: BoxDecoration(
                                color: Colors.black54,
                                borderRadius: BorderRadius.circular(6),
                              ),
                              child: Text(
                                '${index + 1}',
                                style: const TextStyle(
                                  color: Colors.white,
                                  fontWeight: FontWeight.w700,
                                  fontSize: 12,
                                ),
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      '${Formatters.duration(clip.duration)} · ${clip.transition}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}

class _MiniButton extends StatelessWidget {
  const _MiniButton({
    required this.icon,
    required this.color,
    required this.onTap,
  });
  final IconData icon;
  final Color color;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: 26,
        height: 26,
        decoration: BoxDecoration(
          color: Colors.black.withValues(alpha: 0.5),
          shape: BoxShape.circle,
        ),
        child: Icon(icon, size: 16, color: color),
      ),
    );
  }
}

class _ColorSwatch extends StatelessWidget {
  const _ColorSwatch({
    required this.color,
    required this.selected,
    required this.onTap,
  });
  final Color color;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: 36,
        height: 36,
        decoration: BoxDecoration(
          color: color,
          shape: BoxShape.circle,
          border: Border.all(
            color: selected
                ? Theme.of(context).colorScheme.primary
                : Theme.of(context).colorScheme.outlineVariant,
            width: selected ? 3 : 1,
          ),
        ),
        child: selected
            ? Icon(
                Icons.check_rounded,
                size: 18,
                color: color.computeLuminance() > 0.5
                    ? Colors.black
                    : Colors.white,
              )
            : null,
      ),
    );
  }
}
