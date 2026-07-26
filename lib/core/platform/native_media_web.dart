import 'package:flutter/material.dart';
import 'package:video_player/video_player.dart';

/// Web-реализация без `dart:io`: путь — это blob/URL.
Widget nativeFileImage(
  String path, {
  BoxFit fit = BoxFit.cover,
  Widget Function()? onError,
}) {
  return Image.network(
    path,
    fit: fit,
    errorBuilder: (_, _, _) => onError?.call() ?? const SizedBox.shrink(),
  );
}

VideoPlayerController nativeFileVideoController(String path) {
  return VideoPlayerController.networkUrl(Uri.parse(path));
}
