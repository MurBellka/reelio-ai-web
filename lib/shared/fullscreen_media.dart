import 'package:flutter/material.dart';
import 'package:video_player/video_player.dart';

import '../models/enums.dart';
import '../models/media_asset.dart';
import 'platform_media.dart';
import 'unsupported_preview_placeholder.dart';

/// Полноэкранный просмотр выбранного материала.
class FullscreenMediaView extends StatefulWidget {
  const FullscreenMediaView({super.key, required this.asset});

  final MediaAsset asset;

  static Future<void> show(BuildContext context, MediaAsset asset) {
    return Navigator.of(context).push(
      PageRouteBuilder(
        opaque: false,
        barrierColor: Colors.black,
        pageBuilder: (_, _, _) => FullscreenMediaView(asset: asset),
      ),
    );
  }

  @override
  State<FullscreenMediaView> createState() => _FullscreenMediaViewState();
}

class _FullscreenMediaViewState extends State<FullscreenMediaView> {
  VideoPlayerController? _controller;
  bool _initFailed = false;

  @override
  void initState() {
    super.initState();
    if (widget.asset.type == MediaType.video) {
      _initVideo();
    }
  }

  Future<void> _initVideo() async {
    final controller = platformVideoController(widget.asset.path);
    _controller = controller;
    try {
      await controller.initialize().timeout(const Duration(seconds: 8));
      await controller.setLooping(true);
      await controller.play();
      if (mounted) setState(() {});
    } catch (_) {
      // Формат не воспроизводится браузером/плеером (например AVI, MKV)
      // или инициализация зависла — показываем заглушку, а не падаем.
      if (mounted) setState(() => _initFailed = true);
    }
  }

  @override
  void dispose() {
    _controller?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final controller = _controller;
    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(
        children: [
          Center(child: _buildContent(controller)),
          SafeArea(
            child: Align(
              alignment: Alignment.topRight,
              child: Padding(
                padding: const EdgeInsets.all(8),
                child: IconButton.filledTonal(
                  onPressed: () => Navigator.of(context).maybePop(),
                  icon: const Icon(Icons.close_rounded),
                ),
              ),
            ),
          ),
          if (controller != null && controller.value.isInitialized)
            Positioned(
              left: 0,
              right: 0,
              bottom: 0,
              child: SafeArea(child: _VideoControls(controller: controller)),
            ),
        ],
      ),
    );
  }

  Widget _buildContent(VideoPlayerController? controller) {
    if (widget.asset.type == MediaType.photo) {
      return InteractiveViewer(
        child: platformImage(
          widget.asset.path,
          fit: BoxFit.contain,
          onError: () => _placeholder(),
        ),
      );
    }
    if (_initFailed) {
      return _placeholder();
    }
    if (controller == null || !controller.value.isInitialized) {
      return const CircularProgressIndicator(color: Colors.white);
    }
    return AspectRatio(
      aspectRatio: controller.value.aspectRatio,
      child: VideoPlayer(controller),
    );
  }

  Widget _placeholder() => SizedBox(
    width: 280,
    height: 280,
    child: UnsupportedPreviewPlaceholder.forAsset(widget.asset),
  );
}

class _VideoControls extends StatelessWidget {
  const _VideoControls({required this.controller});
  final VideoPlayerController controller;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      color: Colors.black45,
      child: Row(
        children: [
          ValueListenableBuilder(
            valueListenable: controller,
            builder: (context, value, _) => IconButton(
              onPressed: () =>
                  value.isPlaying ? controller.pause() : controller.play(),
              icon: Icon(
                value.isPlaying
                    ? Icons.pause_rounded
                    : Icons.play_arrow_rounded,
                color: Colors.white,
                size: 32,
              ),
            ),
          ),
          Expanded(
            child: VideoProgressIndicator(
              controller,
              allowScrubbing: true,
              colors: const VideoProgressColors(
                playedColor: Color(0xFFC4F82A),
                bufferedColor: Colors.white24,
                backgroundColor: Colors.white12,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
