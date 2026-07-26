import 'package:flutter/material.dart';

import '../core/theme.dart';
import '../models/enums.dart';
import '../models/media_asset.dart';
import 'platform_media.dart';

/// Градиенты, соответствующие стилям монтажа.
List<Color> gradientForStyle(EditStyle style) => switch (style) {
  EditStyle.dynamicStyle => const [Color(0xFF7C3AED), Color(0xFFEC4899)],
  EditStyle.cinematic => const [Color(0xFF1E3A8A), Color(0xFF6D28D9)],
  EditStyle.calm => const [Color(0xFF0D9488), Color(0xFF8B5CF6)],
  EditStyle.minimal => const [Color(0xFF334155), Color(0xFF64748B)],
};

/// Вертикальная 9:16 поверхность демонстрационного ролика.
///
/// Показывает обложку (фото) или стилизованный градиент, пример субтитров,
/// значок музыки и элементы управления. Это убедительное демо, а не результат
/// настоящего рендера.
class DemoReelSurface extends StatelessWidget {
  const DemoReelSurface({
    super.key,
    this.cover,
    this.caption,
    required this.style,
    this.showPlay = false,
    this.isPlaying = false,
    this.progress,
    this.musicLabel,
    this.badge,
    this.onTap,
    this.captionColorHex = '#FFFFFF',
    this.captionStyle = CaptionStyle.bold,
  });

  final MediaAsset? cover;
  final String? caption;
  final EditStyle style;
  final bool showPlay;
  final bool isPlaying;
  final double? progress;
  final String? musicLabel;
  final Widget? badge;
  final VoidCallback? onTap;
  final String captionColorHex;
  final CaptionStyle captionStyle;

  Color get _captionColor {
    final hex = captionColorHex.replaceFirst('#', '');
    final value = int.tryParse(hex, radix: 16);
    if (value == null) return Colors.white;
    return Color(0xFF000000 | value);
  }

  @override
  Widget build(BuildContext context) {
    final colors = gradientForStyle(style);
    final showPhoto = cover != null && cover!.isPhoto;

    return AspectRatio(
      aspectRatio: 9 / 16,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(AppRadius.lg),
          child: Container(
            clipBehavior: Clip.antiAlias,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(AppRadius.lg),
              gradient: LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                colors: colors,
              ),
              boxShadow: [
                BoxShadow(
                  color: colors.last.withValues(alpha: 0.4),
                  blurRadius: 30,
                  offset: const Offset(0, 16),
                ),
              ],
            ),
            child: Stack(
              fit: StackFit.expand,
              children: [
                if (showPhoto) platformImage(cover!.path, fit: BoxFit.cover),
                // Затемнение для читаемости субтитров.
                const DecoratedBox(
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      begin: Alignment.topCenter,
                      end: Alignment.bottomCenter,
                      colors: [Colors.transparent, Colors.black54],
                      stops: [0.55, 1.0],
                    ),
                  ),
                ),
                if (badge != null) Positioned(top: 14, left: 14, child: badge!),
                if (musicLabel != null)
                  Positioned(
                    top: 14,
                    right: 14,
                    child: _GlassChip(
                      icon: Icons.music_note_rounded,
                      label: musicLabel!,
                    ),
                  ),
                if (showPlay)
                  Center(
                    child: AnimatedScale(
                      scale: isPlaying ? 0.0 : 1.0,
                      duration: const Duration(milliseconds: 200),
                      child: Container(
                        width: 64,
                        height: 64,
                        decoration: BoxDecoration(
                          color: Colors.white.withValues(alpha: 0.9),
                          shape: BoxShape.circle,
                        ),
                        child: const Icon(
                          Icons.play_arrow_rounded,
                          size: 40,
                          color: AppColors.deepPurple,
                        ),
                      ),
                    ),
                  ),
                if (caption != null && caption!.isNotEmpty)
                  Positioned(
                    left: 16,
                    right: 16,
                    bottom: progress != null ? 28 : 20,
                    child: _CaptionText(
                      text: caption!,
                      color: _captionColor,
                      style: captionStyle,
                    ),
                  ),
                if (progress != null)
                  Positioned(
                    left: 12,
                    right: 12,
                    bottom: 12,
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(3),
                      child: LinearProgressIndicator(
                        value: progress!.clamp(0.0, 1.0),
                        minHeight: 4,
                        backgroundColor: Colors.white24,
                        valueColor: const AlwaysStoppedAnimation(
                          AppColors.lime,
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _CaptionText extends StatelessWidget {
  const _CaptionText({
    required this.text,
    required this.color,
    required this.style,
  });
  final String text;
  final Color color;
  final CaptionStyle style;

  @override
  Widget build(BuildContext context) {
    final base = Theme.of(context).textTheme.titleMedium!;
    final resolved = switch (style) {
      CaptionStyle.clean => base.copyWith(fontWeight: FontWeight.w600),
      CaptionStyle.bold => base.copyWith(fontWeight: FontWeight.w900),
      CaptionStyle.karaoke => base.copyWith(
        fontWeight: FontWeight.w800,
        letterSpacing: 0.5,
      ),
    };
    return Center(
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        decoration: BoxDecoration(
          color: style == CaptionStyle.karaoke
              ? Colors.black.withValues(alpha: 0.35)
              : Colors.transparent,
          borderRadius: BorderRadius.circular(10),
        ),
        child: Text(
          text,
          textAlign: TextAlign.center,
          style: resolved.copyWith(
            color: color,
            shadows: const [
              Shadow(
                color: Colors.black87,
                blurRadius: 8,
                offset: Offset(0, 1),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _GlassChip extends StatelessWidget {
  const _GlassChip({required this.icon, required this.label});
  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.35),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 14, color: Colors.white),
          const SizedBox(width: 5),
          Text(
            label,
            style: const TextStyle(
              color: Colors.white,
              fontSize: 12,
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }
}
