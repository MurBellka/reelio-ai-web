import 'dart:io';

import 'package:flutter/material.dart';
import 'package:video_player/video_player.dart';

/// Изображение из файла ФС (мобильные/десктоп).
Widget nativeFileImage(
  String path, {
  BoxFit fit = BoxFit.cover,
  Widget Function()? onError,
}) {
  return Image.file(
    File(path),
    fit: fit,
    gaplessPlayback: true,
    errorBuilder: (_, _, _) => onError?.call() ?? const SizedBox.shrink(),
  );
}

/// Контроллер видео из файла ФС (мобильные/десктоп).
VideoPlayerController nativeFileVideoController(String path) {
  return VideoPlayerController.file(File(path));
}
