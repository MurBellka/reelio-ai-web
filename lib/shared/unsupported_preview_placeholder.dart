import 'package:flutter/material.dart';

import '../core/media_validation.dart';
import '../models/media_asset.dart';

/// Карточка-заглушка для материала, который не удалось отобразить в
/// текущем браузере/плеере устройства (например AVI, MKV или HEIC).
///
/// Файл при этом остаётся выбранным — заглушка лишь заменяет предпросмотр,
/// не отклоняя материал. Реальная перекодировка выполняется backend'ом
/// через FFmpeg перед обработкой (см. `ServerTranscodeService`).
class UnsupportedPreviewPlaceholder extends StatelessWidget {
  const UnsupportedPreviewPlaceholder({
    super.key,
    required this.name,
    required this.format,
    this.compact = false,
  });

  factory UnsupportedPreviewPlaceholder.forAsset(
    MediaAsset asset, {
    Key? key,
    bool compact = false,
  }) {
    final ext = MediaLimits.extensionOfAsset(asset);
    return UnsupportedPreviewPlaceholder(
      key: key,
      name: asset.name,
      format: ext.isEmpty ? '—' : ext.toUpperCase(),
      compact: compact,
    );
  }

  final String name;
  final String format;
  final bool compact;

  static const _message = 'Предпросмотр будет доступен после обработки';

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return DecoratedBox(
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [Color(0xFF2A2350), Color(0xFF120E22)],
        ),
      ),
      child: Padding(
        padding: EdgeInsets.all(compact ? 8 : 20),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.center,
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.hourglass_top_rounded,
              color: Colors.white70,
              size: compact ? 20 : 36,
            ),
            SizedBox(height: compact ? 4 : 12),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
              decoration: BoxDecoration(
                color: Colors.white24,
                borderRadius: BorderRadius.circular(6),
              ),
              child: Text(
                format,
                style: TextStyle(
                  color: Colors.white,
                  fontSize: compact ? 9 : 11,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
            if (!compact) ...[
              const SizedBox(height: 10),
              Text(
                name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                textAlign: TextAlign.center,
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: Colors.white,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 6),
              const Text(
                _message,
                textAlign: TextAlign.center,
                style: TextStyle(color: Colors.white70, fontSize: 12),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
