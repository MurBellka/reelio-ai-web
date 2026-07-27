import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/router.dart';
import '../../services/auth_service.dart';
import '../../shared/app_background.dart';
import '../../shared/app_logo.dart';
import '../../shared/premium_widgets.dart';
import '../../state/auth_providers.dart';

/// Общая проверка адреса: не строгая по RFC, но отсекает опечатки.
String? _validateEmail(String? value) {
  final email = (value ?? '').trim();
  if (email.isEmpty) return 'Введите адрес электронной почты';
  if (!RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]{2,}$').hasMatch(email)) {
    return 'Похоже, в адресе опечатка';
  }
  return null;
}

String? _validatePassword(String? value) {
  final password = value ?? '';
  if (password.isEmpty) return 'Введите пароль';
  // Firebase не примет короче шести — говорим об этом до отправки.
  if (password.length < 6) return 'Минимум 6 символов';
  return null;
}

/// Каркас экранов входа: фон, логотип, карточка с формой.
class _AuthScaffold extends StatelessWidget {
  const _AuthScaffold({
    required this.title,
    required this.subtitle,
    required this.child,
    this.showBack = false,
  });

  final String title;
  final String subtitle;
  final Widget child;
  final bool showBack;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: showBack ? AppBar() : null,
      extendBodyBehindAppBar: true,
      body: AppBackground(
        child: SafeArea(
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(24),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 420),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const Center(child: AppLogo()),
                    const SizedBox(height: 24),
                    Text(
                      title,
                      style: theme.textTheme.headlineSmall,
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: 8),
                    Text(
                      subtitle,
                      style: theme.textTheme.bodyMedium?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: 24),
                    SoftCard(child: child),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Показывает ошибку так, чтобы её нельзя было не заметить.
void _showError(BuildContext context, Object error) {
  final message = error is AuthException
      ? error.message
      : 'Что-то пошло не так.';
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(message)));
}

// ── Вход ────────────────────────────────────────────────────────────────────

class SignInScreen extends ConsumerStatefulWidget {
  const SignInScreen({super.key});

  @override
  ConsumerState<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends ConsumerState<SignInScreen> {
  final _formKey = GlobalKey<FormState>();
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _busy = false;
  bool _obscure = true;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    setState(() => _busy = true);
    try {
      final user = await ref
          .read(authServiceProvider)
          .signIn(email: _email.text, password: _password.text);
      if (!mounted) return;
      context.go(
        user.emailVerified ? AppRoutes.onboarding : AppRoutes.verifyEmail,
      );
    } catch (e) {
      if (mounted) _showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return _AuthScaffold(
      title: 'Вход',
      subtitle: 'Войдите, чтобы собирать ролики',
      child: Form(
        key: _formKey,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextFormField(
              controller: _email,
              decoration: const InputDecoration(labelText: 'Почта'),
              keyboardType: TextInputType.emailAddress,
              autofillHints: const [AutofillHints.email],
              validator: _validateEmail,
              enabled: !_busy,
            ),
            const SizedBox(height: 12),
            TextFormField(
              controller: _password,
              decoration: InputDecoration(
                labelText: 'Пароль',
                suffixIcon: IconButton(
                  icon: Icon(
                    _obscure
                        ? Icons.visibility_rounded
                        : Icons.visibility_off_rounded,
                  ),
                  onPressed: () => setState(() => _obscure = !_obscure),
                  tooltip: _obscure ? 'Показать пароль' : 'Скрыть пароль',
                ),
              ),
              obscureText: _obscure,
              autofillHints: const [AutofillHints.password],
              validator: _validatePassword,
              enabled: !_busy,
              onFieldSubmitted: (_) => _submit(),
            ),
            const SizedBox(height: 20),
            GradientButton(
              label: _busy ? 'Входим…' : 'Войти',
              onPressed: _busy ? null : _submit,
            ),
            const SizedBox(height: 8),
            TextButton(
              onPressed: _busy
                  ? null
                  : () => context.push(AppRoutes.resetPassword),
              child: const Text('Забыли пароль?'),
            ),
            const Divider(height: 24),
            TextButton(
              onPressed: _busy ? null : () => context.go(AppRoutes.signUp),
              child: const Text('Нет аккаунта? Зарегистрироваться'),
            ),
          ],
        ),
      ),
    );
  }
}

// ── Регистрация ─────────────────────────────────────────────────────────────

class SignUpScreen extends ConsumerStatefulWidget {
  const SignUpScreen({super.key});

  @override
  ConsumerState<SignUpScreen> createState() => _SignUpScreenState();
}

class _SignUpScreenState extends ConsumerState<SignUpScreen> {
  final _formKey = GlobalKey<FormState>();
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _repeat = TextEditingController();
  bool _busy = false;
  bool _acceptedPolicy = false;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    _repeat.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    if (!_acceptedPolicy) {
      _showError(
        context,
        const AuthException('Подтвердите согласие с политикой.'),
      );
      return;
    }
    setState(() => _busy = true);
    try {
      await ref
          .read(authServiceProvider)
          .register(email: _email.text, password: _password.text);
      if (!mounted) return;
      context.go(AppRoutes.verifyEmail);
    } catch (e) {
      if (mounted) _showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return _AuthScaffold(
      title: 'Регистрация',
      subtitle: 'Бесплатная бета — 4 ролика в сутки',
      child: Form(
        key: _formKey,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextFormField(
              controller: _email,
              decoration: const InputDecoration(labelText: 'Почта'),
              keyboardType: TextInputType.emailAddress,
              autofillHints: const [AutofillHints.email],
              validator: _validateEmail,
              enabled: !_busy,
            ),
            const SizedBox(height: 12),
            TextFormField(
              controller: _password,
              decoration: const InputDecoration(
                labelText: 'Пароль',
                helperText: 'Минимум 6 символов',
              ),
              obscureText: true,
              autofillHints: const [AutofillHints.newPassword],
              validator: _validatePassword,
              enabled: !_busy,
            ),
            const SizedBox(height: 12),
            TextFormField(
              controller: _repeat,
              decoration: const InputDecoration(labelText: 'Повторите пароль'),
              obscureText: true,
              enabled: !_busy,
              validator: (v) =>
                  v == _password.text ? null : 'Пароли не совпадают',
            ),
            const SizedBox(height: 12),
            CheckboxListTile(
              value: _acceptedPolicy,
              onChanged: _busy
                  ? null
                  : (v) => setState(() => _acceptedPolicy = v ?? false),
              contentPadding: EdgeInsets.zero,
              controlAffinity: ListTileControlAffinity.leading,
              title: Text(
                'Согласен с обработкой данных',
                style: theme.textTheme.bodyMedium,
              ),
              subtitle: TextButton(
                onPressed: () => context.push(AppRoutes.privacy),
                style: TextButton.styleFrom(
                  padding: EdgeInsets.zero,
                  minimumSize: const Size(0, 0),
                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  alignment: Alignment.centerLeft,
                ),
                child: const Text('Политика и срок хранения файлов'),
              ),
            ),
            const SizedBox(height: 12),
            GradientButton(
              label: _busy ? 'Создаём…' : 'Создать аккаунт',
              onPressed: _busy ? null : _submit,
            ),
            const Divider(height: 24),
            TextButton(
              onPressed: _busy ? null : () => context.go(AppRoutes.signIn),
              child: const Text('Уже есть аккаунт? Войти'),
            ),
          ],
        ),
      ),
    );
  }
}

// ── Подтверждение почты ─────────────────────────────────────────────────────

class VerifyEmailScreen extends ConsumerStatefulWidget {
  const VerifyEmailScreen({super.key});

  @override
  ConsumerState<VerifyEmailScreen> createState() => _VerifyEmailScreenState();
}

class _VerifyEmailScreenState extends ConsumerState<VerifyEmailScreen> {
  bool _busy = false;
  bool _sent = false;

  Future<void> _resend() async {
    setState(() => _busy = true);
    try {
      await ref.read(authServiceProvider).sendVerificationEmail();
      if (mounted) setState(() => _sent = true);
    } catch (e) {
      if (mounted) _showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _check() async {
    setState(() => _busy = true);
    try {
      final verified = await ref
          .read(authServiceProvider)
          .refreshVerification();
      if (!mounted) return;
      if (verified) {
        context.go(AppRoutes.onboarding);
      } else {
        _showError(
          context,
          const AuthException('Пока не подтверждено. Проверьте почту.'),
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final email = ref.watch(authUserProvider).value?.email ?? '';
    return _AuthScaffold(
      title: 'Подтвердите почту',
      subtitle: email.isEmpty ? '' : 'Письмо отправлено на $email',
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Text(
            'Перейдите по ссылке из письма, затем вернитесь сюда. '
            'Без подтверждения рендер недоступен.',
            textAlign: TextAlign.center,
          ),
          if (_sent) ...[
            const SizedBox(height: 12),
            Text(
              'Письмо отправлено повторно.',
              style: TextStyle(color: Theme.of(context).colorScheme.primary),
            ),
          ],
          const SizedBox(height: 20),
          GradientButton(
            label: _busy ? 'Проверяем…' : 'Я подтвердил',
            onPressed: _busy ? null : _check,
          ),
          const SizedBox(height: 8),
          TextButton(
            onPressed: _busy ? null : _resend,
            child: const Text('Отправить письмо ещё раз'),
          ),
          const Divider(height: 24),
          TextButton(
            onPressed: _busy
                ? null
                : () async {
                    await ref.read(authServiceProvider).signOut();
                    if (context.mounted) context.go(AppRoutes.signIn);
                  },
            child: const Text('Выйти'),
          ),
        ],
      ),
    );
  }
}

// ── Восстановление пароля ───────────────────────────────────────────────────

class ResetPasswordScreen extends ConsumerStatefulWidget {
  const ResetPasswordScreen({super.key});

  @override
  ConsumerState<ResetPasswordScreen> createState() =>
      _ResetPasswordScreenState();
}

class _ResetPasswordScreenState extends ConsumerState<ResetPasswordScreen> {
  final _formKey = GlobalKey<FormState>();
  final _email = TextEditingController();
  bool _busy = false;
  bool _sent = false;

  @override
  void dispose() {
    _email.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    setState(() => _busy = true);
    try {
      await ref.read(authServiceProvider).sendPasswordReset(_email.text);
      if (mounted) setState(() => _sent = true);
    } catch (e) {
      if (mounted) _showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return _AuthScaffold(
      title: 'Восстановление пароля',
      subtitle: 'Пришлём ссылку для смены пароля',
      showBack: true,
      child: _sent
          ? Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Icon(Icons.mark_email_read_rounded, size: 48),
                const SizedBox(height: 12),
                const Text(
                  'Если аккаунт с такой почтой существует, письмо уже отправлено.',
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 20),
                GradientButton(
                  label: 'Вернуться ко входу',
                  onPressed: () => context.go(AppRoutes.signIn),
                ),
              ],
            )
          : Form(
              key: _formKey,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  TextFormField(
                    controller: _email,
                    decoration: const InputDecoration(labelText: 'Почта'),
                    keyboardType: TextInputType.emailAddress,
                    validator: _validateEmail,
                    enabled: !_busy,
                  ),
                  const SizedBox(height: 20),
                  GradientButton(
                    label: _busy ? 'Отправляем…' : 'Отправить ссылку',
                    onPressed: _busy ? null : _submit,
                  ),
                ],
              ),
            ),
    );
  }
}
