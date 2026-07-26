import 'dart:async';

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
const Duration _kDurationProbeTimeout = Duration(seconds: 8);

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
  /// Для видео пытается определить длительность.
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
      if (type == MediaType.video) {
        duration = await _probeDuration(file.path);
      }
      assets.add(
        MediaAsset(
          id: _uuid.v4(),
          path: file.path,
          name: file.name,
          type: type,
          durationSeconds: duration,
        ),
      );
    }
    return assets;
  }

  MediaType _detectType(XFile file) => MediaTypeDetector.detect(
    name: file.name.isNotEmpty ? file.name : file.path,
    mimeType: file.mimeType,
  );

  /// Определяет длительность видео. Возвращает `null`, если длительность не
  /// удалось прочитать (формат без превью, повреждён, недоступен или не
  /// ответил за отведённое время) — материал при этом не отклоняется,
  /// а помечается предупреждением в [MediaLimits.validateBatch].
  Future<double?> _probeDuration(String path) async {
    // На web выбранный файл доступен как blob-URL, а не как файл ФС.
    final controller = platformVideoController(path);
    try {
      await controller.initialize().timeout(_kDurationProbeTimeout);
      final ms = controller.value.duration.inMilliseconds;
      if (ms <= 0) return null;
      return ms / 1000.0;
    } catch (_) {
      return null;
    } finally {
      unawaited(controller.dispose());
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
