import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/constants.dart';

/// Открывает почтовый клиент с адресом поддержки.
///
/// Если открыть не удалось (нет почтового клиента, заблокировано браузером),
/// показываем адрес текстом: пользователь должен получить контакт в любом
/// случае, иначе кнопка «Написать в поддержку» просто ничего не делает.
Future<void> openSupportMail(
  BuildContext context, {
  required String subject,
}) async {
  final uri = Uri.parse(AppConstants.supportMailto(subject: subject));
  var opened = false;
  try {
    opened = await launchUrl(uri, mode: LaunchMode.externalApplication);
  } catch (_) {
    opened = false;
  }

  if (!opened && context.mounted) {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: const Text('Напишите нам: ${AppConstants.supportEmail}'),
          action: SnackBarAction(
            label: 'Копировать',
            onPressed: () => copySupportEmail(context),
          ),
          duration: const Duration(seconds: 8),
        ),
      );
  }
}

/// Кладёт адрес поддержки в буфер обмена.
Future<void> copySupportEmail(BuildContext context) async {
  await Clipboard.setData(const ClipboardData(text: AppConstants.supportEmail));
  if (context.mounted) {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(const SnackBar(content: Text('Адрес скопирован')));
  }
}
