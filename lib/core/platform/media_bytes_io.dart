import 'dart:io';
import 'dart:typed_data';

/// Читает материал с диска.
///
/// Бросает исключение, если файл исчез (например, очищен системой) — вызывающий
/// код показывает пользователю понятное сообщение.
Future<Uint8List> readMediaBytes(String path) => File(path).readAsBytes();
