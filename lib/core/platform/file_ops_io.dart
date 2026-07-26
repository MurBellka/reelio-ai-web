import 'dart:io';

import 'package:path_provider/path_provider.dart';

/// Записывает содержимое во временный каталог приложения и возвращает путь.
Future<String> writeTempFile(String filename, String content) async {
  final dir = await getTemporaryDirectory();
  final file = File('${dir.path}/$filename');
  await file.writeAsString(content);
  return file.path;
}
