import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../services/backend_version_service.dart';
import '../../shared/app_background.dart';
import '../../shared/premium_widgets.dart';
import '../../state/auth_providers.dart';

/// Экран на время переключения сервиса.
///
/// Показывается, когда backend отвечает старой версией API. Загружать материалы
/// в этот момент нельзя: старый и новый API несовместимы по авторизации, и
/// пользователь получил бы отказ уже после выгрузки файлов.
class ServiceUpdatingScreen extends ConsumerStatefulWidget {
  const ServiceUpdatingScreen({super.key, this.onReady});

  /// Вызывается, когда backend обновился и работу можно продолжать.
  final VoidCallback? onReady;

  @override
  ConsumerState<ServiceUpdatingScreen> createState() =>
      _ServiceUpdatingScreenState();
}

class _ServiceUpdatingScreenState extends ConsumerState<ServiceUpdatingScreen> {
  bool _checking = false;

  Future<void> _recheck() async {
    setState(() => _checking = true);
    final status = await ref
        .read(backendVersionServiceProvider)
        .check(force: true);
    if (!mounted) return;
    setState(() => _checking = false);
    if (status.canSubmitWork) {
      widget.onReady?.call();
    } else {
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(
            content: Text(
              status.readiness == BackendReadiness.unreachable
                  ? 'Сервис пока не отвечает. Проверьте подключение.'
                  : 'Обновление ещё идёт. Попробуйте через минуту.',
            ),
          ),
        );
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      body: AppBackground(
        child: SafeArea(
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(24),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 420),
                child: SoftCard(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(
                        Icons.cloud_sync_rounded,
                        size: 56,
                        color: theme.colorScheme.primary,
                      ),
                      const SizedBox(height: 16),
                      Text(
                        'Обновляем сервис',
                        style: theme.textTheme.headlineSmall,
                        textAlign: TextAlign.center,
                      ),
                      const SizedBox(height: 12),
                      Text(
                        'Попробуйте через несколько минут. Пока обновление не '
                        'закончится, материалы не загружаются — иначе они не '
                        'дошли бы до обработки.',
                        style: theme.textTheme.bodyMedium?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                        textAlign: TextAlign.center,
                      ),
                      const SizedBox(height: 24),
                      GradientButton(
                        label: _checking ? 'Проверяем…' : 'Проверить снова',
                        onPressed: _checking ? null : _recheck,
                      ),
                    ],
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
