import 'dart:async';
import 'dart:ui' as ui;

import 'package:flutter/services.dart';
import 'package:image_picker/image_picker.dart';
import 'package:uuid/uuid.dart';

import '../core/media_type_detector.dart';
import '../models/enums.dart';
import '../models/media_asset.dart';
import '../shared/platform_media.dart';

/// Максимальное время ожидания метаданных видео. Некоторые контейнеры
/// (например AVI/MKV) не поддерживаются плеером и иначе могли бы
/// зависнуть на неопределённое время вместо быстрой ошибки.
const Duration _kProbeTimeout = Duration(seconds: 8);

/// Метаданные видео, прочитанные на клиенте.
class _VideoMeta {
  const _VideoMeta({this.durationSeconds, this.width, this.height});
  final double? durationSeconds;
  final int? width;
  final int? height;
}

/// Ошибка выбора материалов с сообщением на русском языке.
class MediaPickerException implements Exception {
  const MediaPickerException(this.message);
  final String message;

  @override
  String toString() => message;
}

/// Обёртка над системным выбором медиа.
///
/// Запрашивает доступ к галерее только в момент выбора и корректно
/// обрабатывает отмену, отказ в доступе и повреждённые файлы.
class MediaPickerService {
  MediaPickerService({ImagePicker? picker, Uuid? uuid})
    : _picker = picker ?? ImagePicker(),
      _uuid = uuid ?? const Uuid();

  final ImagePicker _picker;
  final Uuid _uuid;

  /// Открывает системный выбор нескольких видео и фото.
  ///
  /// Возвращает пустой список, если пользователь отменил выбор.
  /// Для видео и фото пытается определить длительность и размеры.
  Future<List<MediaAsset>> pickMedia() async {
    final List<XFile> files;
    try {
      files = await _picker.pickMultipleMedia();
    } on PlatformException catch (e) {
      throw MediaPickerException(_mapPlatformError(e));
    } catch (_) {
      throw const MediaPickerException(
        'Не удалось открыть галерею. Попробуйте ещё раз.',
      );
    }

    if (files.isEmpty) return const [];

    final assets = <MediaAsset>[];
    for (final file in files) {
      final type = _detectType(file);
      double? duration;
      int? width;
      int? height;
      if (type == MediaType.video) {
        final meta = await _probeVideo(file.path);
        duration = meta.durationSeconds;
        width = meta.width;
        height = meta.height;
      } else {
        final size = await _probePhoto(file);
        width = size?.$1;
        height = size?.$2;
      }
      assets.add(
        MediaAsset(
          id: _uuid.v4(),
          path: file.path,
          name: file.name,
          type: type,
          durationSeconds: duration,
          width: width,
          height: height,
        ),
      );
    }
    return assets;
  }

  MediaType _detectType(XFile file) => MediaTypeDetector.detect(
    name: file.name.isNotEmpty ? file.name : file.path,
    mimeType: file.mimeType,
  );

  /// Определяет длительность и размеры видео. Возвращает пустые метаданные,
  /// если файл не удалось прочитать (формат без превью, повреждён, недоступен
  /// или не ответил за отведённое время) — материал при этом не отклоняется,
  /// а помечается предупреждением в [MediaLimits.validateBatch].
  Future<_VideoMeta> _probeVideo(String path) async {
    // На web выбранный файл доступен как blob-URL, а не как файл ФС.
    final controller = platformVideoController(path);
    try {
      await controller.initialize().timeout(_kProbeTimeout);
      final ms = controller.value.duration.inMilliseconds;
      final size = controller.value.size;
      return _VideoMeta(
        durationSeconds: ms > 0 ? ms / 1000.0 : null,
        width: size.width > 0 ? size.width.round() : null,
        height: size.height > 0 ? size.height.round() : null,
      );
    } catch (_) {
      return const _VideoMeta();
    } finally {
      unawaited(controller.dispose());
    }
  }

  /// Определяет размеры изображения через декодер. Возвращает `null`, если
  /// формат не декодируется в текущем окружении (например HEIC в браузере).
  Future<(int, int)?> _probePhoto(XFile file) async {
    try {
      final bytes = await file.readAsBytes().timeout(_kProbeTimeout);
      final codec = await ui.instantiateImageCodec(bytes);
      final frame = await codec.getNextFrame();
      final w = frame.image.width;
      final h = frame.image.height;
      frame.image.dispose();
      codec.dispose();
      if (w <= 0 || h <= 0) return null;
      return (w, h);
    } catch (_) {
      return null;
    }
  }

  String _mapPlatformError(PlatformException e) {
    switch (e.code) {
      case 'photo_access_denied':
      case 'camera_access_denied':
        return 'Нет доступа к галерее. Разрешите доступ в настройках устройства.';
      case 'multiple_request':
        return 'Выбор уже открыт. Дождитесь завершения.';
      default:
        return 'Не удалось выбрать материалы. Попробуйте ещё раз.';
    }
  }
}
