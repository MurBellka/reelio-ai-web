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

/// Скачивает файл по готовой ссылке (signed URL результата рендера).
///
/// Атрибут `download` действует только для same-origin ответов, поэтому для
/// кросс-доменного signed URL имя файла задаёт сервер через
/// `Content-Disposition`; браузер в любом случае скачает, а не откроет MP4.
void openDownloadUrl(String url, String filename) {
  final anchor = web.document.createElement('a') as web.HTMLAnchorElement
    ..href = url
    ..download = filename
    ..rel = 'noopener'
    ..style.display = 'none';
  web.document.body!.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
