import 'dart:convert';

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/formatters.dart';
import '../../core/platform/file_ops.dart';
import '../../core/theme.dart';
import '../../models/enums.dart';
import '../../models/export_settings.dart';
import '../../shared/app_background.dart';
import '../../shared/premium_widgets.dart';
import '../../shared/stage_progress.dart';
import '../../state/providers.dart';

class ExportScreen extends ConsumerStatefulWidget {
  const ExportScreen({super.key});

  @override
  ConsumerState<ExportScreen> createState() => _ExportScreenState();
}

class _ExportScreenState extends ConsumerState<ExportScreen> {
  bool _exporting = false;

  String _fileName() => Formatters.editPlanFileName(DateTime.now());

  void _selectResolution(ExportResolution choice) {
    final project = ref.read(projectProvider);
    final plan = project.plan;
    if (plan == null) return;
    final settings = ExportResolver.build(
      choice: choice,
      durationSeconds: plan.computedDuration.round(),
      sourceMaxHeight: project.sourceMaxHeight,
    );
    ref.read(projectProvider.notifier).setPlanExport(settings);
  }

  Future<void> _export() async {
    if (_exporting) return; // защита от повторного нажатия
    final plan = ref.read(projectProvider).plan;
    if (plan == null) return;
    setState(() => _exporting = true);
    try {
      final result = await ref.read(exportServiceProvider).export(plan);
      if (!mounted) return;
      final fileName = _fileName();

      if (kIsWeb) {
        // Настоящее браузерное скачивание JSON-плана.
        downloadTextFile(fileName, result.planJson);
      } else {
        await SharePlus.instance.share(
          ShareParams(
            files: [
              XFile.fromData(
                utf8.encode(result.planJson),
                name: fileName,
                mimeType: 'application/json',
              ),
            ],
            subject: 'Reelio AI — монтажный план',
            text:
                'Монтажный план Reelio AI (JSON). Настоящий MP4 создаётся '
                'на сервере после подключения рендеринга.',
          ),
        );
      }
      if (!mounted) return;
      _showDoneSheet(fileName);
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: const Text(
              'Не удалось запустить скачивание. Возможно, браузер '
              'заблокировал загрузку.',
            ),
            action: SnackBarAction(label: 'Повторить', onPressed: _export),
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _exporting = false);
    }
  }

  void _showDoneSheet(String fileName) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => Padding(
        padding: EdgeInsets.fromLTRB(
          24,
          24,
          24,
          24 + MediaQuery.of(ctx).viewPadding.bottom,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 56,
              height: 56,
              decoration: const BoxDecoration(
                color: AppColors.lime,
                shape: BoxShape.circle,
              ),
              child: const Icon(
                Icons.description_rounded,
                color: AppColors.limeDark,
                size: 28,
              ),
            ),
            const SizedBox(height: 16),
            Text(
              'Монтажный план готов',
              style: Theme.of(ctx).textTheme.titleLarge,
            ),
            const SizedBox(height: 8),
            Text(
              kIsWeb
                  ? 'Файл «$fileName» скачан браузером. Это монтажный план (JSON), '
                        'а не видео. Готовый MP4 появится после подключения '
                        'серверного рендеринга.'
                  : 'Мы подготовили монтажный план «$fileName» и открыли меню '
                        '«Поделиться». Это план (JSON), а не видео — MP4 создаётся '
                        'на сервере после подключения рендеринга.',
              textAlign: TextAlign.center,
              style: Theme.of(ctx).textTheme.bodyMedium?.copyWith(
                color: Theme.of(ctx).colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 20),
            SizedBox(
              width: double.infinity,
              child: FilledButton(
                onPressed: () => Navigator.pop(ctx),
                child: const Text('Готово'),
              ),
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final project = ref.watch(projectProvider);
    final plan = project.plan;
    final theme = Theme.of(context);

    if (plan == null) {
      return const Scaffold(
        body: Center(child: Text('Нет ролика для экспорта.')),
      );
    }

    final export = plan.export;

    return Scaffold(
      appBar: AppBar(title: const Text('Экспорт')),
      extendBodyBehindAppBar: true,
      body: AppBackground(
        child: SafeArea(
          child: Column(
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 8, 20, 0),
                child: StageProgress(current: AppStage.export),
              ),
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(20, 16, 20, 16),
                  children: [
                    const SectionHeader(
                      title: 'Качество экспорта',
                      subtitle: 'Вертикальный ролик 9:16 для Reels и Shorts',
                    ),
                    const SizedBox(height: 12),
                    Wrap(
                      spacing: 10,
                      runSpacing: 10,
                      children: [
                        for (final r in [
                          ...ExportResolution.concrete,
                          ExportResolution.maximumAvailable,
                        ])
                          ChoiceChip(
                            label: Text(
                              r.isAuto ? r.label : '${r.label} · ${r.height}p',
                            ),
                            selected: export.resolution == r,
                            onSelected: (_) => _selectResolution(r),
                          ),
                      ],
                    ),
                    if (export.isUpscale) ...[
                      const SizedBox(height: 12),
                      _WarningCard(
                        text:
                            'Выбранное разрешение выше исходного материала. '
                            'Апскейл растянет кадр, но не добавит отсутствующих '
                            'деталей.',
                      ),
                    ],
                    const SizedBox(height: 16),
                    SoftCard(
                      child: Column(
                        children: [
                          _ParamRow(
                            icon: Icons.aspect_ratio_rounded,
                            label: 'Формат',
                            value: '9:16 · ${export.width}×${export.height}',
                          ),
                          const Divider(height: 24),
                          _ParamRow(
                            icon: Icons.high_quality_rounded,
                            label: 'Разрешение',
                            value: export.resolution.isAuto
                                ? 'Максимальное (${export.height}p)'
                                : '${export.height}p',
                          ),
                          const Divider(height: 24),
                          _ParamRow(
                            icon: Icons.speed_rounded,
                            label: 'Кадры',
                            value: '${export.fps} FPS',
                          ),
                          const Divider(height: 24),
                          _ParamRow(
                            icon: Icons.timer_outlined,
                            label: 'Длительность',
                            value: Formatters.durationHuman(
                              plan.computedDuration,
                            ),
                          ),
                          const Divider(height: 24),
                          _ParamRow(
                            icon: Icons.sd_storage_rounded,
                            label: 'Размер (оценка)',
                            value:
                                '≈ ${Formatters.fileSize(export.estimatedSizeBytes)}',
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 16),
                    SoftCard(
                      color: theme.colorScheme.secondaryContainer,
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Icon(
                            Icons.info_outline_rounded,
                            color: theme.colorScheme.primary,
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Text(
                              'Экспорт сохраняет монтажный план (JSON) с выбранным '
                              'разрешением. Тяжёлый рендеринг MP4 выполняется на '
                              'сервере, а не в браузере, — он подключается отдельно.',
                              style: theme.textTheme.bodyMedium,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 4, 20, 12),
                child: GradientButton(
                  label: _exporting
                      ? 'Готовим план…'
                      : (kIsWeb
                            ? 'Скачать план (JSON)'
                            : 'Экспортировать план'),
                  icon: kIsWeb
                      ? Icons.download_rounded
                      : Icons.ios_share_rounded,
                  onPressed: _exporting ? null : _export,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _WarningCard extends StatelessWidget {
  const _WarningCard({required this.text});
  final String text;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: theme.colorScheme.errorContainer,
        borderRadius: BorderRadius.circular(AppRadius.md),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            Icons.warning_amber_rounded,
            color: theme.colorScheme.error,
            size: 22,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              text,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onErrorContainer,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ParamRow extends StatelessWidget {
  const _ParamRow({
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
    return Row(
      children: [
        Icon(icon, color: theme.colorScheme.primary, size: 22),
        const SizedBox(width: 12),
        Expanded(child: Text(label, style: theme.textTheme.titleMedium)),
        Text(
          value,
          style: theme.textTheme.bodyLarge?.copyWith(
            fontWeight: FontWeight.w600,
          ),
        ),
      ],
    );
  }
}
