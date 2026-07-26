import 'dart:convert';

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:share_plus/share_plus.dart';

import '../../core/constants.dart';
import '../../core/formatters.dart';
import '../../core/theme.dart';
import '../../models/enums.dart';
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

  Future<void> _export() async {
    if (_exporting) return; // защита от повторного нажатия
    final plan = ref.read(projectProvider).plan;
    if (plan == null) return;
    setState(() => _exporting = true);
    try {
      final result = await ref.read(exportServiceProvider).export(plan);
      if (!mounted) return;
      // На web файла в ФС нет — шарим/скачиваем план из памяти.
      final file = kIsWeb
          ? XFile.fromData(
              utf8.encode(result.planJson),
              name: 'reelio_plan.json',
              mimeType: 'application/json',
            )
          : XFile(result.planFilePath);
      await SharePlus.instance.share(
        ShareParams(
          files: [file],
          subject: 'Reelio AI — монтажный план',
          text:
              'Демонстрационный экспорт Reelio AI. Настоящий видеофайл '
              'появится, когда будет подключён серверный рендеринг.',
        ),
      );
      if (!mounted) return;
      _showDoneSheet();
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Не удалось выполнить экспорт.')),
        );
      }
    } finally {
      if (mounted) setState(() => _exporting = false);
    }
  }

  void _showDoneSheet() {
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
                Icons.check_rounded,
                color: AppColors.limeDark,
                size: 30,
              ),
            ),
            const SizedBox(height: 16),
            Text(
              'Монтажный план готов',
              style: Theme.of(ctx).textTheme.titleLarge,
            ),
            const SizedBox(height: 8),
            Text(
              'Мы сохранили монтажный план и открыли меню «Поделиться». '
              'Настоящий видеорендеринг MP4 будет подключён позже через '
              'серверный API.',
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
    final plan = ref.watch(projectProvider).plan;
    final theme = Theme.of(context);

    if (plan == null) {
      return const Scaffold(
        body: Center(child: Text('Нет ролика для экспорта.')),
      );
    }

    final duration = plan.computedDuration;
    final estBytes = (duration.clamp(1, 120) * 1.6 * 1024 * 1024).round();

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
                      title: 'Параметры экспорта',
                      subtitle: 'Вертикальный ролик для Reels и Shorts',
                    ),
                    const SizedBox(height: 16),
                    SoftCard(
                      child: Column(
                        children: [
                          _ParamRow(
                            icon: Icons.aspect_ratio_rounded,
                            label: 'Формат',
                            value:
                                '${AppConstants.outputAspectRatio} '
                                '(${AppConstants.outputWidth}×${AppConstants.outputHeight})',
                          ),
                          const Divider(height: 24),
                          _ParamRow(
                            icon: Icons.high_quality_rounded,
                            label: 'Качество',
                            value: '1080p',
                          ),
                          const Divider(height: 24),
                          _ParamRow(
                            icon: Icons.timer_outlined,
                            label: 'Длительность',
                            value: Formatters.durationHuman(duration),
                          ),
                          const Divider(height: 24),
                          _ParamRow(
                            icon: Icons.sd_storage_rounded,
                            label: 'Размер (демо)',
                            value: '≈ ${Formatters.fileSize(estBytes)}',
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
                              'Это демонстрационный экспорт. Приложение сохранит '
                              'монтажный план (JSON) и откроет меню «Поделиться». '
                              'Настоящий MP4 будет создаваться на сервере в '
                              'следующей версии.',
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
                  label: _exporting ? 'Экспортируем…' : 'Экспортировать',
                  icon: Icons.ios_share_rounded,
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
