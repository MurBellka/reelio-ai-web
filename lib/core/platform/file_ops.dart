// Платформенный фасад для записи временных файлов.
//
// На web файловой системы нет — используется заглушка без `dart:io`.
export 'file_ops_io.dart' if (dart.library.html) 'file_ops_web.dart';
