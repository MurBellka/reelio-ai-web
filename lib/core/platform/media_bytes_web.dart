import 'dart:js_interop';
import 'dart:typed_data';

import 'package:web/web.dart' as web;

/// Читает материал по blob-URL, который браузер выдал при выборе файла.
///
/// `fetch` умеет работать со схемой `blob:`, поэтому отдельный File API не нужен.
Future<Uint8List> readMediaBytes(String path) async {
  final response = await web.window.fetch(path.toJS).toDart;
  if (!response.ok) {
    throw StateError('Не удалось прочитать файл (${response.status}).');
  }
  final buffer = await response.arrayBuffer().toDart;
  return buffer.toDart.asUint8List();
}
