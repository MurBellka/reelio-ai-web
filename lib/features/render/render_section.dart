import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/formatters.dart';
import '../../core/platform/file_ops.dart';
import '../../core/theme.dart';
import '../../models/render_job.dart';
import '../../shared/premium_widgets.dart';
import '../../state/render_providers.dart';

/// Блок серверного рендера на экране экспорта: запуск, прогресс, отмена,
/// повтор и скачивание готового MP4.
class RenderSection extends ConsumerStatefulWidget {
  const RenderSection({super.key});

  @override
  ConsumerState<RenderSection> createState() => _RenderSectionState();
}

class _RenderSectionState extends ConsumerState<RenderSection> {
  @override
  void initState() {
    super.initState();
    // После перезагрузки страницы возвращаемся к активной задаче.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) ref.read(renderControllerProvider.notifier).restore();
    });
  }

  Future<void> _download() async {
    final controller = ref.read(renderControllerProvider.notifier);
    // Signed URL живёт около часа, поэтому берём свежий перед скачиванием.
    final download = await controller.requestDownload();
    if (!mounted || download == null) return;

    try {
      if (kIsWeb) {
        openDownloadUrl(download.downloadUrl, download.fileName);
      } else {
        await SharePlus.instance.share(
          ShareParams(
            uri: Uri.parse(download.downloadUrl),
            subject: 'Reelio AI — готовый ролик',
          ),
        );
      }
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: const Text('Не удалось открыть скачивание файла.'),
          action: SnackBarAction(label: 'Повторить', onPressed: _download),
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(renderControllerProvider);
    final controller = ref.read(renderControllerProvider.notifier);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _RenderStatusCard(state: state),
        const SizedBox(height: 12),
        if (state.isMp4Ready)
          _ResultCard(result: state.job!.result!, job: state.job!),
        if (state.isMp4Ready) const SizedBox(height: 12),
        _RenderActions(
          state: state,
          onStart: controller.start,
          onCancel: controller.cancel,
          onRetry: controller.retry,
          onDownload: _download,
        ),
      ],
    );
  }
}

/// Карточка текущего состояния: заголовок, пояснение и полоса прогресса.
class _RenderStatusCard extends StatelessWidget {
  const _RenderStatusCard({required this.state});

  final RenderUiState state;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isError = state.stage == RenderUiStage.failed;
    final showBar =
        state.stage == RenderUiStage.uploading ||
        state.stage == RenderUiStage.submitting ||
        state.stage == RenderUiStage.rendering;

    return SoftCard(
      color: isError ? theme.colorScheme.errorContainer : null,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                _iconFor(state.stage),
                color: isError
                    ? theme.colorScheme.error
                    : theme.colorScheme.primary,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  state.stage.label,
                  style: theme.textTheme.titleMedium,
                ),
              ),
              if (state.isBusy)
                const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            state.detail,
            style: theme.textTheme.bodyMedium?.copyWith(
              color: isError
                  ? theme.colorScheme.onErrorContainer
                  : theme.colorScheme.onSurfaceVariant,
            ),
          ),
          if (showBar) ...[
            const SizedBox(height: 14),
            ClipRRect(
              borderRadius: BorderRadius.circular(AppRadius.sm),
              child: LinearProgressIndicator(
                value: state.stage == RenderUiStage.uploading
                    ? state.uploadProgress
                    : state.renderProgress,
                minHeight: 8,
              ),
            ),
          ],
        ],
      ),
    );
  }

  IconData _iconFor(RenderUiStage stage) => switch (stage) {
    RenderUiStage.planReady => Icons.description_rounded,
    RenderUiStage.uploading => Icons.cloud_upload_rounded,
    RenderUiStage.submitting => Icons.playlist_add_check_rounded,
    RenderUiStage.rendering => Icons.movie_creation_rounded,
    RenderUiStage.ready => Icons.check_circle_rounded,
    RenderUiStage.failed => Icons.error_outline_rounded,
    RenderUiStage.cancelled => Icons.cancel_rounded,
  };
}

/// Параметры готового файла: разрешение, длительность, размер.
class _ResultCard extends StatelessWidget {
  const _ResultCard({required this.result, required this.job});

  final RenderResult result;
  final RenderJob job;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SoftCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Готовый файл', style: theme.textTheme.titleMedium),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              InfoPill(
                label: '${result.width}×${result.height}',
                icon: Icons.high_quality_rounded,
              ),
              InfoPill(
                label: Formatters.durationHuman(result.durationSeconds),
                icon: Icons.timer_outlined,
              ),
              InfoPill(
                label: Formatters.fileSize(result.sizeBytes),
                icon: Icons.sd_storage_rounded,
              ),
              InfoPill(label: '${result.fps} FPS', icon: Icons.speed_rounded),
            ],
          ),
          if (job.expiresAt != null) ...[
            const SizedBox(height: 12),
            Text(
              'Файл хранится на сервере ограниченное время — '
              'скачайте его сейчас.',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// Кнопки сценария: запуск, отмена, повтор, скачивание.
class _RenderActions extends StatelessWidget {
  const _RenderActions({
    required this.state,
    required this.onStart,
    required this.onCancel,
    required this.onRetry,
    required this.onDownload,
  });

  final RenderUiState state;
  final VoidCallback onStart;
  final VoidCallback onCancel;
  final VoidCallback onRetry;
  final VoidCallback onDownload;

  @override
  Widget build(BuildContext context) {
    if (state.canDownload) {
      return GradientButton(
        label: 'Скачать MP4',
        icon: Icons.download_rounded,
        onPressed: onDownload,
      );
    }
    if (state.preparingDownload) {
      return const GradientButton(
        label: 'Готовим ссылку…',
        icon: Icons.download_rounded,
        onPressed: null,
      );
    }
    if (state.canRetry) {
      return GradientButton(
        label: 'Повторить рендер',
        icon: Icons.refresh_rounded,
        onPressed: onRetry,
      );
    }
    if (state.isBusy) {
      return OutlinedButton.icon(
        onPressed: state.canCancel ? onCancel : null,
        icon: const Icon(Icons.close_rounded),
        label: Text(state.cancelling ? 'Отменяем…' : 'Отменить рендер'),
      );
    }
    return GradientButton(
      label: 'Собрать MP4 на сервере',
      icon: Icons.movie_creation_rounded,
      onPressed: state.canStart ? onStart : null,
    );
  }
}
