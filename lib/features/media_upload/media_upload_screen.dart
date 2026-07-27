import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/router.dart';
import '../../core/constants.dart';
import '../../core/formatters.dart';
import '../../core/media_validation.dart';
import '../../models/enums.dart';
import '../../models/media_asset.dart';
import '../../services/media_picker_service.dart';
import '../../shared/profile_button.dart';
import '../../shared/app_background.dart';
import '../../shared/fullscreen_media.dart';
import '../../shared/media_thumbnail.dart';
import '../../shared/premium_widgets.dart';
import '../../shared/stage_progress.dart';
import '../../state/providers.dart';

class MediaUploadScreen extends ConsumerStatefulWidget {
  const MediaUploadScreen({super.key});

  @override
  ConsumerState<MediaUploadScreen> createState() => _MediaUploadScreenState();
}

class _MediaUploadScreenState extends ConsumerState<MediaUploadScreen> {
  bool _isPicking = false;

  Future<void> _pick() async {
    if (_isPicking) return; // защита от повторного нажатия
    setState(() => _isPicking = true);
    try {
      final assets = await ref.read(mediaPickerProvider).pickMedia();
      if (assets.isEmpty) {
        return; // отмена выбора
      }
      final result = ref.read(projectProvider.notifier).addAssets(assets);
      if (!mounted) return;
      _reportResult(result);
    } on MediaPickerException catch (e) {
      if (mounted) _showError(e.message);
    } catch (_) {
      if (mounted) {
        _showError('Не удалось добавить материалы. Попробуйте ещё раз.');
      }
    } finally {
      if (mounted) setState(() => _isPicking = false);
    }
  }

  void _reportResult(AddMediaResult result) {
    if (result.hasAccepted && !result.hasRejections && !result.hasWarnings) {
      _showSnack('Добавлено материалов: ${result.accepted.length}');
    } else if (result.hasRejections || result.hasWarnings) {
      _showResultDialog(result);
    }
  }

  void _showResultDialog(AddMediaResult result) {
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(
          result.hasRejections
              ? (result.hasAccepted
                    ? 'Часть файлов не добавлена'
                    : 'Файлы не добавлены')
              : 'Материалы добавлены с предупреждением',
        ),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (result.hasAccepted)
                Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: Text('Добавлено: ${result.accepted.length}.'),
                ),
              ...result.rejected
                  .take(6)
                  .map(
                    (r) => Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Text('• ${r.name}: ${r.reason}'),
                    ),
                  ),
              if (result.rejected.length > 6)
                Text('… и ещё ${result.rejected.length - 6}.'),
              if (result.hasWarnings) ...[
                if (result.hasRejections) const SizedBox(height: 12),
                Text(
                  'Предупреждения:',
                  style: Theme.of(ctx).textTheme.titleSmall,
                ),
                const SizedBox(height: 6),
                ...result.warnings
                    .take(6)
                    .map(
                      (w) => Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: Text('• ${w.name}: ${w.reason}'),
                      ),
                    ),
                if (result.warnings.length > 6)
                  Text('… и ещё ${result.warnings.length - 6}.'),
              ],
            ],
          ),
        ),
        actions: [
          FilledButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('Понятно'),
          ),
        ],
      ),
    );
  }

  void _showError(String message) {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  void _showSnack(String message) {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  void _confirmDelete(MediaAsset asset) {
    ref.read(projectProvider.notifier).removeAsset(asset.id);
    _showSnack('Материал удалён');
  }

  void _continue() {
    ref.read(projectProvider.notifier).setStage(AppStage.settings);
    context.push(AppRoutes.settings);
  }

  @override
  Widget build(BuildContext context) {
    final project = ref.watch(projectProvider);
    final assets = project.assets;
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Материалы'),
        actions: const [ProfileButton()],
      ),
      extendBodyBehindAppBar: true,
      body: AppBackground(
        child: SafeArea(
          child: Column(
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 8, 20, 0),
                child: StageProgress(current: AppStage.upload),
              ),
              const SizedBox(height: 16),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 20),
                child: Row(
                  children: [
                    Expanded(
                      child: _CounterCard(
                        icon: Icons.videocam_rounded,
                        label: 'Видео',
                        value: project.videoCount,
                        max: AppConstants.maxVideos,
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: _CounterCard(
                        icon: Icons.photo_rounded,
                        label: 'Фото',
                        value: project.photoCount,
                        max: AppConstants.maxPhotos,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 12),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 20),
                child: Row(
                  children: [
                    Icon(
                      Icons.info_outline_rounded,
                      size: 16,
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                    const SizedBox(width: 6),
                    Text(
                      'Одно видео — до 10 минут',
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 12),
              Expanded(
                child: assets.isEmpty
                    ? _EmptyState(isPicking: _isPicking, onPick: _pick)
                    : _MediaList(
                        assets: assets,
                        onReorder: (o, n) => ref
                            .read(projectProvider.notifier)
                            .reorderAssets(o, n),
                        onDelete: _confirmDelete,
                        onTap: (a) => FullscreenMediaView.show(context, a),
                      ),
              ),
              _BottomBar(
                canContinue: assets.isNotEmpty,
                isPicking: _isPicking,
                showPick: assets.isNotEmpty,
                onPick: _pick,
                onContinue: _continue,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _CounterCard extends StatelessWidget {
  const _CounterCard({
    required this.icon,
    required this.label,
    required this.value,
    required this.max,
  });
  final IconData icon;
  final String label;
  final int value;
  final int max;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final full = value >= max;
    return SoftCard(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      child: Row(
        children: [
          Icon(icon, color: scheme.primary, size: 22),
          const SizedBox(width: 10),
          Expanded(
            child: Text(label, style: Theme.of(context).textTheme.titleMedium),
          ),
          Text(
            '$value/$max',
            style: Theme.of(context).textTheme.titleMedium?.copyWith(
              color: full ? scheme.error : scheme.primary,
              fontWeight: FontWeight.w800,
            ),
          ),
        ],
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState({required this.isPicking, required this.onPick});
  final bool isPicking;
  final VoidCallback onPick;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 96,
              height: 96,
              decoration: BoxDecoration(
                color: theme.colorScheme.secondaryContainer,
                borderRadius: BorderRadius.circular(28),
              ),
              child: Icon(
                Icons.perm_media_rounded,
                size: 44,
                color: theme.colorScheme.primary,
              ),
            ),
            const SizedBox(height: 20),
            Text('Добавьте материалы', style: theme.textTheme.titleLarge),
            const SizedBox(height: 8),
            Text(
              'Выберите видео и фото из галереи. До 20 видео и 20 фотографий.',
              textAlign: TextAlign.center,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 24),
            GradientButton(
              label: isPicking ? 'Открываем галерею…' : 'Выбрать из галереи',
              icon: Icons.add_photo_alternate_rounded,
              expanded: false,
              onPressed: isPicking ? null : onPick,
            ),
          ],
        ),
      ),
    );
  }
}

class _MediaList extends StatelessWidget {
  const _MediaList({
    required this.assets,
    required this.onReorder,
    required this.onDelete,
    required this.onTap,
  });

  final List<MediaAsset> assets;
  final void Function(int, int) onReorder;
  final void Function(MediaAsset) onDelete;
  final void Function(MediaAsset) onTap;

  @override
  Widget build(BuildContext context) {
    return ReorderableListView.builder(
      padding: const EdgeInsets.fromLTRB(20, 4, 20, 12),
      itemCount: assets.length,
      onReorderItem: onReorder,
      proxyDecorator: (child, index, animation) =>
          Material(color: Colors.transparent, child: child),
      itemBuilder: (context, index) {
        final asset = assets[index];
        return Padding(
          key: ValueKey(asset.id),
          padding: const EdgeInsets.only(bottom: 12),
          child: _MediaRow(
            asset: asset,
            index: index,
            onDelete: () => onDelete(asset),
            onTap: () => onTap(asset),
          ),
        );
      },
    );
  }
}

class _MediaRow extends StatelessWidget {
  const _MediaRow({
    required this.asset,
    required this.index,
    required this.onDelete,
    required this.onTap,
  });

  final MediaAsset asset;
  final int index;
  final VoidCallback onDelete;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final subtitle = asset.isVideo
        ? 'Видео • ${asset.durationSeconds != null ? Formatters.duration(asset.durationSeconds!) : '—'}'
        : 'Фото';
    return SoftCard(
      padding: const EdgeInsets.all(10),
      onTap: onTap,
      child: Row(
        children: [
          SizedBox(width: 60, height: 60, child: MediaThumbnail(asset: asset)),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  asset.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.titleMedium,
                ),
                const SizedBox(height: 4),
                Row(
                  children: [
                    Icon(
                      Icons.check_circle_rounded,
                      size: 15,
                      color: theme.colorScheme.primary,
                    ),
                    const SizedBox(width: 4),
                    Text(
                      subtitle,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
          IconButton(
            onPressed: onDelete,
            tooltip: 'Удалить',
            icon: Icon(
              Icons.delete_outline_rounded,
              color: theme.colorScheme.error,
            ),
          ),
          ReorderableDragStartListener(
            index: index,
            child: Padding(
              padding: const EdgeInsets.only(left: 4, right: 6),
              child: Icon(
                Icons.drag_handle_rounded,
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _BottomBar extends StatelessWidget {
  const _BottomBar({
    required this.canContinue,
    required this.isPicking,
    required this.showPick,
    required this.onPick,
    required this.onContinue,
  });

  final bool canContinue;
  final bool isPicking;
  final bool showPick;
  final VoidCallback onPick;
  final VoidCallback onContinue;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(20, 12, 20, 12),
      child: Row(
        children: [
          if (showPick) ...[
            Expanded(
              child: OutlinedButton.icon(
                onPressed: isPicking ? null : onPick,
                icon: const Icon(Icons.add_rounded),
                label: const Text('Добавить'),
              ),
            ),
            const SizedBox(width: 12),
          ],
          Expanded(
            flex: showPick ? 1 : 2,
            child: GradientButton(
              label: 'Продолжить',
              icon: Icons.arrow_forward_rounded,
              onPressed: canContinue ? onContinue : null,
            ),
          ),
        ],
      ),
    );
  }
}
