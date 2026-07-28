import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/formatters.dart';
import '../../core/theme.dart';
import '../../models/edit_plan.dart';
import '../../models/enums.dart';
import '../../models/media_asset.dart';
import '../../models/transition.dart';
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

  Future<void> _pickTransition(int index, EditClip clip) async {
    final current = TransitionType.fromStorage(clip.transition);
    final picked = await showModalBottomSheet<TransitionType>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => _TransitionPickerSheet(current: current),
    );
    if (picked != null) {
      ref.read(projectProvider.notifier).setClipTransition(index, picked);
    }
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
                      subtitle:
                          'Перетащите, чтобы изменить порядок. '
                          'Нажмите на переход, чтобы сменить его',
                    ),
                    const SizedBox(height: 12),
                    _Timeline(
                      plan: plan,
                      onReorder: controller.reorderClips,
                      onDelete: (i) => _deleteClip(i, plan),
                      onCover: (id) => controller.setCover(id),
                      onPickTransition: (i) =>
                          _pickTransition(i, plan.clips[i]),
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
                    const SectionHeader(title: 'Звук'),
                    const SizedBox(height: 8),
                    SoftCard(
                      child: Row(
                        children: [
                          Icon(
                            plan.audio.keepOriginal
                                ? Icons.volume_up_rounded
                                : Icons.volume_off_rounded,
                            color: theme.colorScheme.primary,
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  'Оригинальный звук',
                                  style: theme.textTheme.titleMedium,
                                ),
                                Text(
                                  plan.audio.keepOriginal
                                      ? 'Звук исходников сохранится'
                                      : 'Ролик будет без звука',
                                  style: theme.textTheme.bodySmall?.copyWith(
                                    color: theme.colorScheme.onSurfaceVariant,
                                  ),
                                ),
                              ],
                            ),
                          ),
                          Switch(
                            value: plan.audio.keepOriginal,
                            onChanged: controller.setKeepOriginalSound,
                          ),
                        ],
                      ),
                    ),
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
    required this.onPickTransition,
  });

  final EditPlan plan;
  final void Function(int, int) onReorder;
  final void Function(int) onDelete;
  final void Function(String) onCover;
  final void Function(int) onPickTransition;

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
      height: 182,
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
          final transition = TransitionType.fromStorage(clip.transition);
          // Только миниатюра — ручка перетаскивания. Чип перехода вынесен из
          // слушателя, иначе тап по нему начинал бы drag.
          return Padding(
            key: ValueKey(clip.id),
            padding: const EdgeInsets.only(right: 12),
            child: SizedBox(
              width: 104,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  ReorderableDragStartListener(
                    index: index,
                    child: SizedBox(
                      height: 128,
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
                                '${index + 1} · ${Formatters.duration(clip.duration)}',
                                style: const TextStyle(
                                  color: Colors.white,
                                  fontWeight: FontWeight.w700,
                                  fontSize: 11,
                                ),
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(height: 8),
                  _TransitionChip(
                    transition: transition,
                    onTap: () => onPickTransition(index),
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}

/// Тап-цель выбора перехода под миниатюрой клипа.
class _TransitionChip extends StatelessWidget {
  const _TransitionChip({required this.transition, required this.onTap});
  final TransitionType transition;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(AppRadius.sm),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
        decoration: BoxDecoration(
          color: theme.colorScheme.surfaceContainerHighest.withValues(
            alpha: 0.5,
          ),
          borderRadius: BorderRadius.circular(AppRadius.sm),
          border: Border.all(color: theme.colorScheme.outlineVariant),
        ),
        child: Row(
          children: [
            Icon(transition.icon, size: 15, color: theme.colorScheme.primary),
            const SizedBox(width: 5),
            Expanded(
              child: Text(
                transition.label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: theme.textTheme.labelSmall,
              ),
            ),
            Icon(
              Icons.expand_more_rounded,
              size: 15,
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ],
        ),
      ),
    );
  }
}

/// Каталог переходов v2 (§2.1), сгруппированный по разделам. Возвращает
/// выбранный тип через `Navigator.pop`.
class _TransitionPickerSheet extends StatelessWidget {
  const _TransitionPickerSheet({required this.current});
  final TransitionType current;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final byGroup = TransitionType.byGroup;
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.of(context).size.height * 0.7,
        ),
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.fromLTRB(20, 4, 20, 20),
          children: [
            Text('Переход', style: theme.textTheme.titleLarge),
            const SizedBox(height: 4),
            Text(
              'Как один клип сменяется следующим',
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 12),
            for (final group in byGroup.keys) ...[
              Padding(
                padding: const EdgeInsets.only(top: 12, bottom: 8),
                child: Text(
                  group.label,
                  style: theme.textTheme.labelLarge?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (final t in byGroup[group]!)
                    ChoiceChip(
                      avatar: Icon(t.icon, size: 18),
                      label: Text(t.label),
                      selected: t == current,
                      onSelected: (_) => Navigator.of(context).pop(t),
                    ),
                ],
              ),
            ],
          ],
        ),
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
