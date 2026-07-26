// Платформенный фасад для работы с медиа из файловой системы.
//
// На мобильных/десктопе используется реализация на `dart:io`, на web —
// безопасная реализация без `dart:io` (blob/URL). Выбор происходит на этапе
// компиляции через conditional import, поэтому `dart:io` не попадает в web-сборку.
export 'native_media_io.dart' if (dart.library.html) 'native_media_web.dart';
