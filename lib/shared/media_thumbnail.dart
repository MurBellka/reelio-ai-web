import 'package:flutter/material.dart';

import '../core/formatters.dart';
import '../core/theme.dart';
import '../models/media_asset.dart';
import 'platform_media.dart';
import 'unsupported_preview_placeholder.dart';

/// Превью материала: фото рендерится из файла, видео — стилизованной плиткой.
class MediaThumbnail extends StatelessWidget {
  const MediaThumbnail({
    super.key,
    required this.asset,
    this.borderRadius,
    this.showDuration = true,
  });

  final MediaAsset asset;
  final BorderRadius? borderRadius;
  final bool showDuration;

  @override
  Widget build(BuildContext context) {
    final radius = borderRadius ?? BorderRadius.circular(AppRadius.sm);
    return ClipRRect(
      borderRadius: radius,
      child: Stack(
        fit: StackFit.expand,
        children: [
          if (asset.isPhoto)
            platformImage(
              asset.path,
              fit: BoxFit.cover,
              onError: () =>
                  UnsupportedPreviewPlaceholder.forAsset(asset, compact: true),
            )
          else
            const _VideoTile(),
          if (asset.isVideo)
            const Center(
              child: Icon(
                Icons.play_circle_fill_rounded,
                color: Colors.white,
                size: 34,
              ),
            ),
          if (showDuration && asset.isVideo && asset.durationSeconds != null)
            Positioned(
              right: 6,
              bottom: 6,
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                decoration: BoxDecoration(
                  color: Colors.black.withValues(alpha: 0.6),
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Text(
                  Formatters.duration(asset.durationSeconds!),
                  style: const TextStyle(
                    color: Colors.white,
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _VideoTile extends StatelessWidget {
  const _VideoTile();

  @override
  Widget build(BuildContext context) {
    return const DecoratedBox(
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [Color(0xFF4C1D95), Color(0xFF7C3AED)],
        ),
      ),
      child: Align(
        alignment: Alignment.topLeft,
        child: Padding(
          padding: EdgeInsets.all(8),
          child: Icon(Icons.videocam_rounded, color: Colors.white70, size: 18),
        ),
      ),
    );
  }
}
