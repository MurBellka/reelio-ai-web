import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:video_player/video_player.dart';

import '../core/platform/native_media.dart';

/// Кросс-платформенное изображение: на web грузит blob/URL, на мобильных — файл.
///
/// Обращение к файловой системе изолировано в conditional-import модуле, чтобы
/// `dart:io` не попадал в web-сборку.
Widget platformImage(
  String path, {
  BoxFit fit = BoxFit.cover,
  Widget Function()? onError,
}) {
  if (kIsWeb) {
    return Image.network(
      path,
      fit: fit,
      errorBuilder: (_, _, _) => onError?.call() ?? const SizedBox.shrink(),
    );
  }
  return nativeFileImage(path, fit: fit, onError: onError);
}

/// Кросс-платформенный контроллер видео: web использует URL, мобильные — файл.
VideoPlayerController platformVideoController(String path) {
  return kIsWeb
      ? VideoPlayerController.networkUrl(Uri.parse(path))
      : nativeFileVideoController(path);
}
