import 'package:flutter/material.dart';

import '../core/theme.dart';
import '../models/enums.dart';

/// Индикатор этапов пайплайна: от загрузки материалов до экспорта.
class StageProgress extends StatelessWidget {
  const StageProgress({super.key, required this.current});

  final AppStage current;

  static const List<AppStage> pipeline = [
    AppStage.upload,
    AppStage.settings,
    AppStage.processing,
    AppStage.preview,
    AppStage.editor,
    AppStage.export,
  ];

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    // Правки — необязательный шаг; для индикатора приравниваем к предпросмотру.
    final effective = current == AppStage.editor ? AppStage.preview : current;
    final currentIndex = pipeline
        .indexOf(effective)
        .clamp(0, pipeline.length - 1);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(
              'Шаг ${currentIndex + 1} из ${pipeline.length}',
              style: theme.textTheme.labelLarge?.copyWith(
                color: scheme.primary,
              ),
            ),
            Text(
              current.label,
              style: theme.textTheme.labelLarge?.copyWith(
                color: scheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
        Row(
          children: [
            for (var i = 0; i < pipeline.length; i++) ...[
              Expanded(
                child: AnimatedContainer(
                  duration: const Duration(milliseconds: 250),
                  height: 6,
                  decoration: BoxDecoration(
                    color: i <= currentIndex
                        ? (i == currentIndex ? scheme.primary : AppColors.lime)
                        : scheme.surfaceContainerHighest,
                    borderRadius: BorderRadius.circular(4),
                  ),
                ),
              ),
              if (i != pipeline.length - 1) const SizedBox(width: 6),
            ],
          ],
        ),
      ],
    );
  }
}
