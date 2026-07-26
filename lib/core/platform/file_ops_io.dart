import 'dart:io';

import 'package:path_provider/path_provider.dart';

/// Записывает содержимое во временный каталог приложения и возвращает путь.
Future<String> writeTempFile(String filename, String content) async {
  final dir = await getTemporaryDirectory();
  final file = File('${dir.path}/$filename');
  await file.writeAsString(content);
  return file.path;
}

/// На мобильных/десктопе скачивание не используется — файл шарится системным
/// меню. Заглушка нужна для единого API фасада.
void downloadTextFile(
  String filename,
  String content, {
  String mimeType = 'application/json',
}) {
  // no-op: см. share на нативных платформах.
}
