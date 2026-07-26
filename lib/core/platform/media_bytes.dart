// Платформенный фасад для чтения байтов выбранного материала.
//
// На нативных платформах путь — это файл на диске, на web — blob-URL,
// поэтому реализации разные, а сигнатура одна.
export 'media_bytes_io.dart'
    if (dart.library.js_interop) 'media_bytes_web.dart';
