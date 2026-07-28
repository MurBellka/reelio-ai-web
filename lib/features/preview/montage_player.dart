import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:video_player/video_player.dart';

import '../../core/constants.dart';
import '../../core/formatters.dart';
import '../../core/media_validation.dart';
import '../../core/theme.dart';
import '../../models/edit_plan.dart';
import '../../models/enums.dart';
import '../../models/font_catalog.dart';
import '../../models/media_asset.dart';
import '../../shared/platform_media.dart';
import '../../shared/unsupported_preview_placeholder.dart';

/// Демонстрационный проигрыватель монтажа: последовательно проигрывает клипы
/// плана — видео через настоящий плеер, фото с эффектом pan/zoom (Ken Burns).
///
/// Это честное демо на основе выбранных материалов, а не результат серверного
/// рендера MP4. Субтитры, элементы управления, прогресс и время накладываются
/// поверх кадра 9:16.
class MontagePlayer extends StatefulWidget {
  const MontagePlayer({
    super.key,
    required this.plan,
    required this.assetsByPath,
    this.badge,
  });

  final EditPlan plan;
  final Map<String, MediaAsset> assetsByPath;
  final Widget? badge;

  @override
  State<MontagePlayer> createState() => _MontagePlayerState();
}

class _MontagePlayerState extends State<MontagePlayer>
    with SingleTickerProviderStateMixin {
  late final AnimationController _clip;
  final Map<String, VideoPlayerController> _videoCache = {};

  int _index = 0;
  bool _playing = true;
  bool _loading = false;
  bool _failed = false;
  VideoPlayerController? _current;

  List<EditClip> get _clips => widget.plan.clips;
  double get _total => widget.plan.computedDuration;

  @override
  void initState() {
    super.initState();
    _clip = AnimationController(vsync: this)
      ..addStatusListener((s) {
        if (s == AnimationStatus.completed) _advance();
      });
    if (_clips.isNotEmpty) {
      _enterClip(0);
    }
  }

  @override
  void dispose() {
    _clip.dispose();
    for (final c in _videoCache.values) {
      c.dispose();
    }
    _videoCache.clear();
    super.dispose();
  }

  double _cumulativeBefore(int index) {
    var sum = 0.0;
    for (var i = 0; i < index && i < _clips.length; i++) {
      sum += _clips[i].duration;
    }
    return sum;
  }

  bool _needsServerTranscode(MediaAsset asset) {
    final ext = MediaLimits.extensionOfAsset(asset);
    return AppConstants.serverTranscodeExtensions.contains(ext);
  }

  /// Готовит контроллер видео (с кэшем). Возвращает `null`, если формат не
  /// декодируется браузером/плеером.
  Future<VideoPlayerController?> _ensureVideo(String path) async {
    final cached = _videoCache[path];
    if (cached != null) {
      return cached.value.isInitialized ? cached : null;
    }
    final controller = platformVideoController(path);
    _videoCache[path] = controller;
    try {
      await controller.initialize().timeout(const Duration(seconds: 8));
      await controller.setLooping(false);
      return controller;
    } catch (_) {
      return null;
    }
  }

  Future<void> _enterClip(int index, {double startOffset = 0}) async {
    if (_clips.isEmpty) return;
    _index = index;
    final clip = _clips[index];
    final asset = widget.assetsByPath[clip.filePath];

    _clip.stop();
    _clip.duration = Duration(
      milliseconds: math.max(300, (clip.duration * 1000).round()),
    );

    // Останавливаем предыдущее видео, если оно другое.
    if (_current != null && _current != _videoCache[clip.filePath]) {
      await _current!.pause();
    }

    var failed = false;
    VideoPlayerController? current;

    final isPlayableVideo =
        clip.type == MediaType.video &&
        asset != null &&
        !_needsServerTranscode(asset);

    if (isPlayableVideo) {
      if (mounted) setState(() => _loading = true);
      current = await _ensureVideo(clip.filePath);
      if (current == null) {
        failed = true;
      } else {
        final seekTo = (clip.start ?? 0) + startOffset;
        await current.seekTo(Duration(milliseconds: (seekTo * 1000).round()));
        if (_playing) await current.play();
      }
    } else if (clip.type == MediaType.video) {
      // Видео без ассета или требующее серверной перекодировки.
      failed = true;
    }

    if (!mounted) return;
    setState(() {
      _current = current;
      _failed = failed;
      _loading = false;
    });

    final fromValue = clip.duration > 0
        ? (startOffset / clip.duration).clamp(0.0, 1.0)
        : 0.0;
    if (_playing) {
      _clip.forward(from: fromValue);
    } else {
      _clip.value = fromValue;
    }
  }

  void _advance() {
    if (_clips.isEmpty) return;
    _pauseCurrentVideo();
    final next = (_index + 1) % _clips.length;
    _enterClip(next);
  }

  void _pauseCurrentVideo() {
    final c = _current;
    if (c != null && c.value.isInitialized) c.pause();
  }

  void _togglePlay() {
    setState(() => _playing = !_playing);
    if (_playing) {
      _clip.forward(from: _clip.value >= 1.0 ? 0 : _clip.value);
      _current?.play();
    } else {
      _clip.stop();
      _pauseCurrentVideo();
    }
  }

  void _seekToFraction(double fraction) {
    if (_clips.isEmpty || _total <= 0) return;
    final global = (fraction.clamp(0.0, 1.0)) * _total;
    var cumulative = 0.0;
    var target = _clips.length - 1;
    for (var i = 0; i < _clips.length; i++) {
      if (global < cumulative + _clips[i].duration) {
        target = i;
        break;
      }
      cumulative += _clips[i].duration;
    }
    final offset = (global - cumulative).clamp(0.0, _clips[target].duration);
    _pauseCurrentVideo();
    _enterClip(target, startOffset: offset.toDouble());
  }

  double _globalFraction() {
    if (_clips.isEmpty || _total <= 0) return 0;
    final clip = _clips[_index];
    final global = _cumulativeBefore(_index) + _clip.value * clip.duration;
    return (global / _total).clamp(0.0, 1.0);
  }

  @override
  Widget build(BuildContext context) {
    if (_clips.isEmpty) {
      return AspectRatio(
        aspectRatio: 9 / 16,
        child: ClipRRect(
          borderRadius: BorderRadius.circular(AppRadius.lg),
          child: const UnsupportedPreviewPlaceholder(
            name: 'Нет клипов',
            format: '—',
          ),
        ),
      );
    }

    final plan = widget.plan;
    final captions = plan.captions;

    return AspectRatio(
      aspectRatio: 9 / 16,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(AppRadius.lg),
        child: AnimatedBuilder(
          animation: _clip,
          builder: (context, _) {
            final fraction = _globalFraction();
            return Stack(
              fit: StackFit.expand,
              children: [
                _buildClipVisual(),
                // Затемнение снизу для читаемости субтитров и контролов.
                const DecoratedBox(
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      begin: Alignment.topCenter,
                      end: Alignment.bottomCenter,
                      colors: [Colors.transparent, Colors.black87],
                      stops: [0.55, 1.0],
                    ),
                  ),
                ),
                if (widget.badge != null)
                  Positioned(top: 12, left: 12, child: widget.badge!),
                if (!plan.audio.keepOriginal)
                  Positioned(
                    top: 12,
                    right: 12,
                    child: _Chip(
                      icon: Icons.volume_off_rounded,
                      label: 'Без звука',
                    ),
                  ),
                // Тап по центру — play/pause.
                Positioned.fill(
                  child: GestureDetector(
                    behavior: HitTestBehavior.opaque,
                    onTap: _togglePlay,
                    child: Center(
                      child: AnimatedOpacity(
                        opacity: _playing ? 0 : 1,
                        duration: const Duration(milliseconds: 180),
                        child: _CircleIcon(
                          icon: Icons.play_arrow_rounded,
                          onTap: _togglePlay,
                        ),
                      ),
                    ),
                  ),
                ),
                // Субтитры в безопасной зоне, над панелью управления.
                if (captions.enabled && captions.sampleText.isNotEmpty)
                  Positioned(
                    left: 14,
                    right: 14,
                    bottom: 64,
                    child: _Caption(
                      text: captions.sampleText,
                      colorHex: captions.colorHex,
                      style: captions.style,
                    ),
                  ),
                // Панель управления: play/pause + прогресс + время.
                Positioned(
                  left: 8,
                  right: 8,
                  bottom: 8,
                  child: _Controls(
                    playing: _playing,
                    fraction: fraction,
                    current: fraction * _total,
                    total: _total,
                    onToggle: _togglePlay,
                    onSeek: _seekToFraction,
                  ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _buildClipVisual() {
    final clip = _clips[_index];
    final asset = widget.assetsByPath[clip.filePath];

    if (_loading) {
      return const ColoredBox(
        color: Colors.black,
        child: Center(child: CircularProgressIndicator(color: Colors.white)),
      );
    }

    if (_failed || asset == null) {
      return UnsupportedPreviewPlaceholder.forAsset(
        asset ??
            MediaAsset(
              id: clip.id,
              path: clip.filePath,
              name: clip.sourceName.isEmpty ? 'Материал' : clip.sourceName,
              type: clip.type,
            ),
      );
    }

    if (clip.type == MediaType.video) {
      final controller = _current;
      if (controller != null && controller.value.isInitialized) {
        return FittedBox(
          fit: BoxFit.cover,
          clipBehavior: Clip.hardEdge,
          child: SizedBox(
            width: controller.value.size.width,
            height: controller.value.size.height,
            child: VideoPlayer(controller),
          ),
        );
      }
      return const ColoredBox(color: Colors.black);
    }

    // Фото: Ken Burns pan/zoom по значению анимации клипа.
    final t = _clip.value;
    final scale = 1.06 + 0.14 * t;
    final dir = _index.isEven ? 1.0 : -1.0;
    final dx = dir * 3.0 * (t - 0.5);
    final dy = -2.4 * (t - 0.5);
    return Transform.translate(
      offset: Offset(dx, dy),
      child: Transform.scale(
        scale: scale,
        child: platformImage(asset.path, fit: BoxFit.cover),
      ),
    );
  }
}

class _Controls extends StatelessWidget {
  const _Controls({
    required this.playing,
    required this.fraction,
    required this.current,
    required this.total,
    required this.onToggle,
    required this.onSeek,
  });

  final bool playing;
  final double fraction;
  final double current;
  final double total;
  final VoidCallback onToggle;
  final ValueChanged<double> onSeek;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        IconButton(
          onPressed: onToggle,
          iconSize: 26,
          padding: const EdgeInsets.all(8),
          constraints: const BoxConstraints(minWidth: 44, minHeight: 44),
          icon: Icon(
            playing ? Icons.pause_rounded : Icons.play_arrow_rounded,
            color: Colors.white,
          ),
        ),
        Expanded(
          child: SliderTheme(
            data: SliderThemeData(
              trackHeight: 3,
              thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 6),
              overlayShape: const RoundSliderOverlayShape(overlayRadius: 14),
              activeTrackColor: AppColors.lime,
              inactiveTrackColor: Colors.white30,
              thumbColor: Colors.white,
            ),
            child: Slider(value: fraction.clamp(0.0, 1.0), onChanged: onSeek),
          ),
        ),
        Padding(
          padding: const EdgeInsets.only(right: 8, left: 4),
          child: Text(
            '${Formatters.duration(current)} / ${Formatters.duration(total)}',
            style: const TextStyle(
              color: Colors.white,
              fontSize: 12,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
      ],
    );
  }
}

class _Caption extends StatelessWidget {
  const _Caption({
    required this.text,
    required this.colorHex,
    required this.style,
  });
  final String text;
  final String colorHex;
  final CaptionStyle style;

  Color get _color {
    final hex = colorHex.replaceFirst('#', '');
    final v = int.tryParse(hex, radix: 16);
    return v == null ? Colors.white : Color(0xFF000000 | v);
  }

  @override
  Widget build(BuildContext context) {
    // Тот же шрифт (§6, default inter) и веса, что уйдут в MP4, а не системный.
    final base = Theme.of(
      context,
    ).textTheme.titleMedium!.copyWith(fontFamily: kCaptionPreviewFont.family);
    final resolved = switch (style) {
      CaptionStyle.clean => base.copyWith(fontWeight: FontWeight.w500),
      CaptionStyle.bold => base.copyWith(fontWeight: FontWeight.w700),
      CaptionStyle.karaoke => base.copyWith(
        fontWeight: FontWeight.w700,
        letterSpacing: 0.5,
      ),
    };
    return Center(
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        decoration: BoxDecoration(
          color: style == CaptionStyle.karaoke
              ? Colors.black.withValues(alpha: 0.4)
              : Colors.transparent,
          borderRadius: BorderRadius.circular(10),
        ),
        child: Text(
          text,
          textAlign: TextAlign.center,
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
          style: resolved.copyWith(
            color: _color,
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

class _CircleIcon extends StatelessWidget {
  const _CircleIcon({required this.icon, required this.onTap});
  final IconData icon;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
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
    );
  }
}

class _Chip extends StatelessWidget {
  const _Chip({required this.icon, required this.label});
  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.4),
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
