import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/router.dart';
import '../../core/theme.dart';
import '../../models/enums.dart';
import '../../services/ai_editing_service.dart';
import '../../shared/app_background.dart';
import '../../state/providers.dart';

const _stages = <String>[
  'Анализируем материалы',
  'Ищем лучшие моменты',
  'Собираем историю',
  'Добавляем переходы',
  'Создаём субтитры',
  'Выравниваем звук',
  'Готовим предпросмотр',
];

class ProcessingScreen extends ConsumerStatefulWidget {
  const ProcessingScreen({super.key});

  @override
  ConsumerState<ProcessingScreen> createState() => _ProcessingScreenState();
}

class _ProcessingScreenState extends ConsumerState<ProcessingScreen>
    with TickerProviderStateMixin {
  late final AnimationController _progress;
  late final AnimationController _orb;
  bool _finishing = false;
  bool _navigated = false;

  @override
  void initState() {
    super.initState();
    // Продолжительность мок-обработки — 8–12 секунд.
    final ms = 8000 + math.Random().nextInt(4000);
    _progress = AnimationController(
      vsync: this,
      duration: Duration(milliseconds: ms),
    )..addStatusListener(_onStatus);
    _orb = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 3),
    )..repeat();
    _progress.forward();
  }

  void _onStatus(AnimationStatus status) {
    if (status == AnimationStatus.completed) _finish();
  }

  Future<void> _finish() async {
    if (_finishing || _navigated) return; // единственный процесс
    _finishing = true;
    try {
      final project = ref.read(projectProvider);
      final plan = await ref
          .read(aiServiceProvider)
          .createEditPlan(project.toRequest());
      if (!mounted) return;
      final controller = ref.read(projectProvider.notifier);
      controller.setPlan(plan);
      controller.setStage(AppStage.preview);
      _navigated = true;
      context.pushReplacement(AppRoutes.preview);
    } on AiEditingException catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(e.message)));
      context.pop();
    } catch (_) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Не удалось собрать ролик. Попробуйте ещё раз.'),
        ),
      );
      context.pop();
    }
  }

  Future<void> _confirmCancel() async {
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
      _progress.stop();
      ref.read(aiServiceProvider).cancel();
      context.pop();
    }
  }

  @override
  void dispose() {
    _progress.dispose();
    _orb.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _confirmCancel();
      },
      child: Scaffold(
        body: AppBackground(
          child: SafeArea(
            child: AnimatedBuilder(
              animation: _progress,
              builder: (context, _) {
                final value = _progress.value;
                final percent = (value * 100).round();
                final currentStage = (value * _stages.length).floor().clamp(
                  0,
                  _stages.length - 1,
                );
                return Padding(
                  padding: const EdgeInsets.fromLTRB(24, 16, 24, 24),
                  child: Column(
                    children: [
                      Align(
                        alignment: Alignment.centerLeft,
                        child: IconButton(
                          onPressed: _confirmCancel,
                          icon: const Icon(Icons.close_rounded),
                        ),
                      ),
                      const Spacer(),
                      _AiOrb(orb: _orb, progress: value),
                      const SizedBox(height: 32),
                      Text(
                        '$percent%',
                        style: theme.textTheme.displaySmall?.copyWith(
                          color: theme.colorScheme.primary,
                        ),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        _stages[currentStage],
                        style: theme.textTheme.titleLarge,
                        textAlign: TextAlign.center,
                      ),
                      const SizedBox(height: 24),
                      ClipRRect(
                        borderRadius: BorderRadius.circular(8),
                        child: LinearProgressIndicator(
                          value: value,
                          minHeight: 8,
                          backgroundColor:
                              theme.colorScheme.surfaceContainerHighest,
                          valueColor: AlwaysStoppedAnimation(
                            theme.colorScheme.primary,
                          ),
                        ),
                      ),
                      const SizedBox(height: 28),
                      Expanded(
                        child: SingleChildScrollView(
                          child: Column(
                            children: [
                              for (var i = 0; i < _stages.length; i++)
                                _StageRow(
                                  label: _stages[i],
                                  done:
                                      i < currentStage ||
                                      (i == currentStage && value >= 1.0),
                                  active: i == currentStage && value < 1.0,
                                ),
                            ],
                          ),
                        ),
                      ),
                    ],
                  ),
                );
              },
            ),
          ),
        ),
      ),
    );
  }
}

class _StageRow extends StatelessWidget {
  const _StageRow({
    required this.label,
    required this.done,
    required this.active,
  });
  final String label;
  final bool done;
  final bool active;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 7),
      child: Row(
        children: [
          AnimatedContainer(
            duration: const Duration(milliseconds: 250),
            width: 28,
            height: 28,
            decoration: BoxDecoration(
              color: done
                  ? AppColors.lime
                  : active
                  ? scheme.primary
                  : scheme.surfaceContainerHighest,
              shape: BoxShape.circle,
            ),
            child: done
                ? const Icon(
                    Icons.check_rounded,
                    size: 18,
                    color: AppColors.limeDark,
                  )
                : active
                ? const Padding(
                    padding: EdgeInsets.all(7),
                    child: CircularProgressIndicator(
                      strokeWidth: 2.4,
                      color: Colors.white,
                    ),
                  )
                : null,
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Text(
              label,
              style: theme.textTheme.bodyLarge?.copyWith(
                color: done || active
                    ? scheme.onSurface
                    : scheme.onSurfaceVariant,
                fontWeight: active ? FontWeight.w700 : FontWeight.w500,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _AiOrb extends StatelessWidget {
  const _AiOrb({required this.orb, required this.progress});
  final AnimationController orb;
  final double progress;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: orb,
      builder: (context, _) {
        return SizedBox(
          width: 180,
          height: 180,
          child: Stack(
            alignment: Alignment.center,
            children: [
              Transform.rotate(
                angle: orb.value * 2 * math.pi,
                child: Container(
                  width: 180,
                  height: 180,
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
                width: 150,
                height: 150,
                decoration: BoxDecoration(
                  color: Theme.of(context).scaffoldBackgroundColor,
                  shape: BoxShape.circle,
                ),
              ),
              Transform.scale(
                scale: 1 + 0.06 * math.sin(orb.value * 2 * math.pi),
                child: Container(
                  width: 108,
                  height: 108,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    gradient: const LinearGradient(
                      colors: [AppColors.purple, AppColors.deepPurple],
                    ),
                    boxShadow: [
                      BoxShadow(
                        color: AppColors.deepPurple.withValues(alpha: 0.5),
                        blurRadius: 30,
                      ),
                    ],
                  ),
                  child: const Icon(
                    Icons.auto_awesome_rounded,
                    color: Colors.white,
                    size: 44,
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
