import 'dart:async';
import 'dart:convert';
import 'dart:js_interop';

import 'package:web/web.dart' as web;

/// Web-заглушка: файловой системы нет, план скачивается браузером.
Future<String> writeTempFile(String filename, String content) async => '';

/// Запускает настоящее браузерное скачивание текстового файла (Blob + anchor).
///
/// Бросает исключение, если браузер заблокировал операцию — вызывающий код
/// показывает пользователю сообщение и предлагает повтор.
void downloadTextFile(
  String filename,
  String content, {
  String mimeType = 'application/json',
}) {
  final bytes = utf8.encode(content).toJS;
  final blob = web.Blob([bytes].toJS, web.BlobPropertyBag(type: mimeType));
  final url = web.URL.createObjectURL(blob);
  final anchor = web.document.createElement('a') as web.HTMLAnchorElement
    ..href = url
    ..download = filename
    ..style.display = 'none';
  web.document.body!.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Освобождаем временный URL чуть позже, чтобы не прервать загрузку.
  Timer(const Duration(seconds: 4), () => web.URL.revokeObjectURL(url));
}
