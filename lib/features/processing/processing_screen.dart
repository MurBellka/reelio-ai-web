import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/router.dart';
import '../../core/theme.dart';
import '../../shared/app_background.dart';
import '../../state/processing_providers.dart';

/// Экран обработки: два раздельных, видимых этапа — «Загрузка материалов»
/// (прогресс по переданным байтам) и «AI анализирует материалы» (серверные
/// phase/fraction). Прогресс монотонный; 100 % этап показывает только по
/// фактическому завершению.
class ProcessingScreen extends ConsumerStatefulWidget {
  const ProcessingScreen({super.key});

  @override
  ConsumerState<ProcessingScreen> createState() => _ProcessingScreenState();
}

class _ProcessingScreenState extends ConsumerState<ProcessingScreen>
    with SingleTickerProviderStateMixin {
  late final AnimationController _orb;
  bool _navigated = false;

  @override
  void initState() {
    super.initState();
    _orb = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 3),
    )..repeat();
    // Запускаем обработку после первого кадра, когда провайдеры готовы.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(processingControllerProvider.notifier).start();
    });
  }

  @override
  void dispose() {
    _orb.dispose();
    super.dispose();
  }

  void _goToPreview() {
    if (_navigated || !mounted) return;
    _navigated = true;
    context.pushReplacement(AppRoutes.preview);
  }

  Future<void> _confirmCancel() async {
    final state = ref.read(processingControllerProvider);
    if (!state.isBusy) {
      // Уже завершилось/отменено/ошибка — просто выходим назад.
      if (mounted) context.pop();
      return;
    }
    final cancel = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Прервать обработку?'),
        content: const Text('Ролик ещё не готов. Прогресс будет сброшен.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Продолжить'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Прервать'),
          ),
        ],
      ),
    );
    if (cancel == true && mounted) {
      ref.read(processingControllerProvider.notifier).cancel();
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(processingControllerProvider);

    // Готовый план — уходим в предпросмотр.
    ref.listen(processingControllerProvider, (prev, next) {
      if (next.isDone) _goToPreview();
    });

    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _confirmCancel();
      },
      child: Scaffold(
        body: AppBackground(
          child: SafeArea(
            child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 480),
                child: SingleChildScrollView(
                  padding: const EdgeInsets.fromLTRB(20, 12, 20, 24),
                  child: _Body(
                    state: state,
                    orb: _orb,
                    onCancel: _confirmCancel,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _Body extends StatelessWidget {
  const _Body({required this.state, required this.orb, required this.onCancel});

  final ProcessingUiState state;
  final AnimationController orb;
  final Future<void> Function() onCancel;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final failed = state.stage == ProcessingStage.failed;
    final cancelled = state.stage == ProcessingStage.cancelled;

    // Показываем этап загрузки, если он в принципе есть (v2). У мока/v1 отдельной
    // загрузки нет — тогда виден только этап анализа.
    final hasUploadStage = state.upload.totalFiles > 0 || state.isUploading;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Align(
          alignment: Alignment.centerLeft,
          child: IconButton(
            onPressed: onCancel,
            icon: const Icon(Icons.close_rounded),
            tooltip: 'Прервать',
          ),
        ),
        const SizedBox(height: 8),
        Center(child: _AiOrb(orb: orb)),
        const SizedBox(height: 24),
        Text(
          switch (state.stage) {
            ProcessingStage.preparing ||
            ProcessingStage.uploading ||
            ProcessingStage.analyzing => 'Собираем ваш ролик',
            ProcessingStage.done => 'Готово',
            ProcessingStage.cancelled => 'Обработка отменена',
            ProcessingStage.failed => 'Что-то пошло не так',
          },
          style: theme.textTheme.titleLarge,
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 20),

        if (failed || cancelled)
          _Problem(state: state)
        else ...[
          if (hasUploadStage)
            _StageCard(
              title: 'Загрузка материалов',
              subtitle: _uploadSubtitle(state),
              value: state.uploadProgress,
              status: _statusOf(
                active: state.isUploading,
                done: state.uploadComplete,
              ),
              semanticName: 'Загрузка материалов',
            ),
          if (hasUploadStage) const SizedBox(height: 12),
          _StageCard(
            title: 'AI анализирует материалы',
            subtitle: _analysisSubtitle(state, hasUploadStage),
            value: state.analysisProgress,
            status: _statusOf(
              active: state.isAnalyzing,
              done: state.isDone,
              waiting: hasUploadStage && !state.uploadComplete,
            ),
            semanticName: 'AI анализирует материалы',
          ),
        ],
      ],
    );
  }

  static _StageStatus _statusOf({
    required bool active,
    required bool done,
    bool waiting = false,
  }) {
    if (done) return _StageStatus.done;
    if (active) return _StageStatus.active;
    if (waiting) return _StageStatus.waiting;
    return _StageStatus.active;
  }

  static String _uploadSubtitle(ProcessingUiState state) {
    if (state.uploadComplete) return 'Материалы загружены';
    final counter = state.uploadCounter;
    final name = state.currentFileName;
    if (counter.isEmpty) return 'Готовим загрузку…';
    return name.isEmpty ? counter : '$counter · $name';
  }

  static String _analysisSubtitle(ProcessingUiState state, bool hasUpload) {
    if (state.isDone) return 'Монтажный план готов';
    if (hasUpload && !state.uploadComplete) return 'Ждём загрузку материалов';
    final message = state.analysisMessage;
    return message.isEmpty ? 'AI разбирает материалы' : message;
  }
}

enum _StageStatus { waiting, active, done }

/// Карточка одного этапа с раздельной, доступной полосой прогресса.
class _StageCard extends StatelessWidget {
  const _StageCard({
    required this.title,
    required this.subtitle,
    required this.value,
    required this.status,
    required this.semanticName,
  });

  final String title;
  final String subtitle;
  final double value;
  final _StageStatus status;
  final String semanticName;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final percent = (value.clamp(0.0, 1.0) * 100).round();
    final waiting = status == _StageStatus.waiting;
    final done = status == _StageStatus.done;

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest.withValues(alpha: 0.4),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(
          color: status == _StageStatus.active
              ? scheme.primary
              : scheme.outlineVariant.withValues(alpha: 0.4),
          width: status == _StageStatus.active ? 1.5 : 1,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              _StatusDot(status: status),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  title,
                  style: theme.textTheme.titleMedium?.copyWith(
                    color: waiting ? scheme.onSurfaceVariant : scheme.onSurface,
                  ),
                ),
              ),
              Text(
                done ? 'Готово' : '$percent%',
                style: theme.textTheme.labelLarge?.copyWith(
                  color: done ? AppColors.limeDark : scheme.primary,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          ClipRRect(
            borderRadius: BorderRadius.circular(8),
            child: LinearProgressIndicator(
              // Ожидающий этап — 0; активный без числа — неопределённый бегунок.
              value: waiting ? 0 : value.clamp(0.0, 1.0),
              minHeight: 8,
              backgroundColor: scheme.surfaceContainerHighest,
              valueColor: AlwaysStoppedAnimation(
                done ? AppColors.lime : scheme.primary,
              ),
              // Доступность: экранный диктор читает имя этапа; процент для
              // определённого индикатора Flutter озвучивает сам.
              semanticsLabel: semanticName,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            subtitle,
            style: theme.textTheme.bodyMedium?.copyWith(
              color: scheme.onSurfaceVariant,
            ),
          ),
        ],
      ),
    );
  }
}

class _StatusDot extends StatelessWidget {
  const _StatusDot({required this.status});
  final _StageStatus status;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return SizedBox(
      width: 22,
      height: 22,
      child: switch (status) {
        _StageStatus.done => Container(
          decoration: const BoxDecoration(
            color: AppColors.lime,
            shape: BoxShape.circle,
          ),
          child: const Icon(
            Icons.check_rounded,
            size: 15,
            color: AppColors.limeDark,
          ),
        ),
        _StageStatus.active => const Padding(
          padding: EdgeInsets.all(2),
          child: CircularProgressIndicator(strokeWidth: 2.4),
        ),
        _StageStatus.waiting => Container(
          decoration: BoxDecoration(
            color: scheme.surfaceContainerHighest,
            shape: BoxShape.circle,
          ),
        ),
      },
    );
  }
}

/// Блок ошибки/отмены с понятными действиями: повторить или вернуться.
class _Problem extends ConsumerWidget {
  const _Problem({required this.state});
  final ProcessingUiState state;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final cancelled = state.stage == ProcessingStage.cancelled;
    final error = state.error;
    final message = cancelled
        ? 'Обработка остановлена. Можно запустить заново.'
        : error?.message ?? 'Не удалось обработать материалы.';
    final where = error?.isUpload ?? false
        ? 'Ошибка на этапе загрузки'
        : cancelled
        ? 'Отменено'
        : 'Ошибка на этапе анализа';

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: scheme.errorContainer.withValues(alpha: cancelled ? 0.25 : 0.5),
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Icon(
                cancelled ? Icons.cancel_outlined : Icons.error_outline_rounded,
                color: cancelled ? scheme.onSurfaceVariant : scheme.error,
                size: 20,
              ),
              const SizedBox(width: 8),
              Expanded(child: Text(where, style: theme.textTheme.labelLarge)),
            ],
          ),
          const SizedBox(height: 8),
          Text(message, style: theme.textTheme.bodyMedium),
          const SizedBox(height: 16),
          Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  onPressed: () => context.pop(),
                  child: const Text('Назад'),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: FilledButton(
                  onPressed: () =>
                      ref.read(processingControllerProvider.notifier).retry(),
                  child: const Text('Повторить'),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _AiOrb extends StatelessWidget {
  const _AiOrb({required this.orb});
  final AnimationController orb;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: orb,
      builder: (context, _) {
        return SizedBox(
          width: 132,
          height: 132,
          child: Stack(
            alignment: Alignment.center,
            children: [
              Transform.rotate(
                angle: orb.value * 2 * math.pi,
                child: Container(
                  width: 132,
                  height: 132,
                  decoration: const BoxDecoration(
                    shape: BoxShape.circle,
                    gradient: SweepGradient(
                      colors: [
                        AppColors.purple,
                        AppColors.lime,
                        AppColors.deepPurple,
                        AppColors.purple,
                      ],
                    ),
                  ),
                ),
              ),
              Container(
                width: 110,
                height: 110,
                decoration: BoxDecoration(
                  color: Theme.of(context).scaffoldBackgroundColor,
                  shape: BoxShape.circle,
                ),
              ),
              Transform.scale(
                scale: 1 + 0.06 * math.sin(orb.value * 2 * math.pi),
                child: Container(
                  width: 80,
                  height: 80,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    gradient: const LinearGradient(
                      colors: [AppColors.purple, AppColors.deepPurple],
                    ),
                    boxShadow: [
                      BoxShadow(
                        color: AppColors.deepPurple.withValues(alpha: 0.5),
                        blurRadius: 24,
                      ),
                    ],
                  ),
                  child: const Icon(
                    Icons.auto_awesome_rounded,
                    color: Colors.white,
                    size: 34,
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}
