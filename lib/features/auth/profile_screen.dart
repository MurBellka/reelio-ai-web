import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/router.dart';
import '../../shared/app_background.dart';
import '../../shared/premium_widgets.dart';
import '../../state/auth_providers.dart';
import '../../state/providers.dart';

/// Профиль: кто вошёл, сколько осталось кредитов, удаление данных.
class ProfileScreen extends ConsumerStatefulWidget {
  const ProfileScreen({super.key});

  @override
  ConsumerState<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends ConsumerState<ProfileScreen> {
  bool _busy = false;

  Future<bool> _confirm({
    required String title,
    required String message,
    required String confirmLabel,
  }) async {
    final result = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: Text(message),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Отмена'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: Theme.of(ctx).colorScheme.error,
              foregroundColor: Theme.of(ctx).colorScheme.onError,
            ),
            onPressed: () => Navigator.pop(ctx, true),
            child: Text(confirmLabel),
          ),
        ],
      ),
    );
    return result ?? false;
  }

  Future<void> _deleteProject() async {
    final project = ref.read(projectProvider);
    final projectId = project.id;
    if (projectId.isEmpty) return;

    final ok = await _confirm(
      title: 'Удалить проект?',
      message:
          'Исходники и готовые ролики этого проекта будут удалены с сервера '
          'без возможности восстановления.',
      confirmLabel: 'Удалить',
    );
    if (!ok) return;

    setState(() => _busy = true);
    try {
      await ref.read(accountApiProvider).deleteProject(projectId);
      ref.invalidate(accountUsageProvider);
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('Проект удалён.')));
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Не удалось удалить проект.')),
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _deleteAccount() async {
    final ok = await _confirm(
      title: 'Удалить аккаунт?',
      message:
          'Будут удалены аккаунт, все проекты, исходники и готовые ролики. '
          'Это необратимо.',
      confirmLabel: 'Удалить навсегда',
    );
    if (!ok) return;

    setState(() => _busy = true);
    try {
      // Сервер удаляет данные и учётную запись; клиенту остаётся закрыть сессию.
      await ref.read(accountApiProvider).deleteAccount();
      await ref.read(authServiceProvider).forgetSession();
      if (!mounted) return;
      context.go(AppRoutes.signIn);
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Не удалось удалить аккаунт. Попробуйте ещё раз.'),
          ),
        );
        setState(() => _busy = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final user = ref.watch(authUserProvider).value;
    final usage = ref.watch(accountUsageProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Профиль')),
      body: AppBackground(
        child: SafeArea(
          child: ListView(
            padding: const EdgeInsets.all(16),
            children: [
              SoftCard(
                child: Row(
                  children: [
                    CircleAvatar(
                      radius: 24,
                      backgroundColor: theme.colorScheme.primaryContainer,
                      child: const Icon(Icons.person_rounded),
                    ),
                    const SizedBox(width: 16),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            user?.email ?? '—',
                            style: theme.textTheme.titleMedium,
                          ),
                          const SizedBox(height: 4),
                          Text(
                            user?.emailVerified == true
                                ? 'Почта подтверждена'
                                : 'Почта не подтверждена',
                            style: theme.textTheme.bodySmall?.copyWith(
                              color: user?.emailVerified == true
                                  ? theme.colorScheme.primary
                                  : theme.colorScheme.error,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 16),

              const SectionHeader(
                title: 'Лимиты беты',
                subtitle: 'Обновляются каждые сутки',
              ),
              const SizedBox(height: 8),
              usage.when(
                loading: () => const SoftCard(
                  child: Center(
                    child: Padding(
                      padding: EdgeInsets.all(16),
                      child: CircularProgressIndicator(),
                    ),
                  ),
                ),
                error: (_, _) => const SoftCard(
                  child: Text(
                    'Не удалось загрузить остаток. Потяните экран, чтобы обновить.',
                  ),
                ),
                data: (u) => Column(
                  children: [
                    SoftCard(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            mainAxisAlignment: MainAxisAlignment.spaceBetween,
                            children: [
                              Text(
                                'Осталось рендеров',
                                style: theme.textTheme.titleMedium,
                              ),
                              Text(
                                '${u.creditsRemaining} из ${u.creditsLimit}',
                                style: theme.textTheme.titleMedium?.copyWith(
                                  color: u.exhausted
                                      ? theme.colorScheme.error
                                      : theme.colorScheme.primary,
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 12),
                          ClipRRect(
                            borderRadius: BorderRadius.circular(8),
                            child: LinearProgressIndicator(
                              value: u.creditsLimit == 0
                                  ? 0
                                  : u.creditsRemaining / u.creditsLimit,
                              minHeight: 8,
                            ),
                          ),
                          const SizedBox(height: 12),
                          Text(
                            'Стоимость: 720p и 1080p — 1, 2K — 2, 4K — 4.',
                            style: theme.textTheme.bodySmall,
                          ),
                          if (u.exhausted) ...[
                            const SizedBox(height: 12),
                            _LimitNotice(retentionDays: u.retentionDays),
                          ],
                        ],
                      ),
                    ),
                    const SizedBox(height: 12),
                    SoftCard(
                      child: Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          const Text('Запросы к AI'),
                          Text('${u.editPlanRemaining} из ${u.editPlanLimit}'),
                        ],
                      ),
                    ),
                    const SizedBox(height: 12),
                    SoftCard(
                      child: Row(
                        children: [
                          const Icon(Icons.schedule_rounded),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Text(
                              'Готовые ролики и исходники хранятся ${u.retentionDays} дней, '
                              'затем удаляются автоматически.',
                              style: theme.textTheme.bodyMedium,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),

              const SizedBox(height: 24),
              const SectionHeader(
                title: 'Данные',
                subtitle: 'Удаление необратимо',
              ),
              const SizedBox(height: 8),
              SoftCard(
                child: Column(
                  children: [
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: const Icon(Icons.folder_delete_rounded),
                      title: const Text('Удалить текущий проект'),
                      subtitle: const Text(
                        'Исходники и готовые ролики проекта',
                      ),
                      onTap: _busy ? null : _deleteProject,
                    ),
                    const Divider(height: 1),
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: const Icon(Icons.privacy_tip_rounded),
                      title: const Text('Политика и хранение файлов'),
                      onTap: () => context.push(AppRoutes.privacy),
                    ),
                  ],
                ),
              ),

              const SizedBox(height: 16),
              OutlinedButton.icon(
                onPressed: _busy
                    ? null
                    : () async {
                        await ref.read(authServiceProvider).signOut();
                        if (context.mounted) context.go(AppRoutes.signIn);
                      },
                icon: const Icon(Icons.logout_rounded),
                label: const Text('Выйти'),
              ),
              const SizedBox(height: 8),
              TextButton.icon(
                onPressed: _busy ? null : _deleteAccount,
                style: TextButton.styleFrom(
                  foregroundColor: theme.colorScheme.error,
                ),
                icon: const Icon(Icons.delete_forever_rounded),
                label: const Text('Удалить аккаунт'),
              ),
              const SizedBox(height: 24),
            ],
          ),
        ),
      ),
    );
  }
}

/// Сообщение о дневном лимите — объясняет, что делать дальше.
class _LimitNotice extends StatelessWidget {
  const _LimitNotice({required this.retentionDays});

  final int retentionDays;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: theme.colorScheme.errorContainer,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            Icons.info_outline_rounded,
            color: theme.colorScheme.onErrorContainer,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              'Дневной лимит исчерпан. Новые рендеры станут доступны завтра — '
              'счётчик обновляется в полночь по UTC. Уже готовые ролики можно '
              'скачивать ещё $retentionDays дней.',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onErrorContainer,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Политика конфиденциальности и срок хранения.
class PrivacyScreen extends StatelessWidget {
  const PrivacyScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    Widget section(String title, String body) => Padding(
      padding: const EdgeInsets.only(bottom: 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: theme.textTheme.titleMedium),
          const SizedBox(height: 6),
          Text(body, style: theme.textTheme.bodyMedium),
        ],
      ),
    );

    return Scaffold(
      appBar: AppBar(title: const Text('Конфиденциальность')),
      body: AppBackground(
        child: SafeArea(
          child: ListView(
            padding: const EdgeInsets.all(20),
            children: [
              section(
                'Что мы храним',
                'Адрес электронной почты, загруженные видео и фотографии, '
                    'монтажный план и готовый ролик. Пароль хранится в Firebase '
                    'Authentication и нам недоступен.',
              ),
              section(
                'Сколько храним',
                'Готовые ролики и рабочие файлы задачи — 7 дней. Загруженные '
                    'исходники — до 30 дней. После этого файлы удаляются '
                    'автоматически. Удалить раньше можно в профиле.',
              ),
              section(
                'Кто имеет доступ',
                'Только вы. Файлы лежат в каталоге, привязанном к вашему '
                    'аккаунту, и запрос к чужим данным отклоняется сервером.',
              ),
              section(
                'AI-обработка',
                'Для составления монтажного плана в Google Gemini передаются '
                    'параметры проекта и ваш текстовый запрос. Сами видео и '
                    'фотографии в Gemini не отправляются.',
              ),
              section(
                'Удаление',
                'В профиле можно удалить отдельный проект или весь аккаунт. '
                    'При удалении аккаунта стираются учётная запись и все '
                    'связанные файлы.',
              ),
            ],
          ),
        ),
      ),
    );
  }
}
