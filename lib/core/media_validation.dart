import '../models/enums.dart';
import '../models/media_asset.dart';
import 'constants.dart';

/// Отклонённый материал с причиной на русском языке.
class RejectedMedia {
  const RejectedMedia({required this.name, required this.reason});
  final String name;
  final String reason;
}

/// Результат добавления материалов.
class AddMediaResult {
  const AddMediaResult({
    required this.accepted,
    required this.rejected,
    this.warnings = const [],
  });
  final List<MediaAsset> accepted;
  final List<RejectedMedia> rejected;

  /// Материалы, которые были приняты, но требуют внимания пользователя
  /// (например, не удалось определить длительность видео).
  final List<RejectedMedia> warnings;

  bool get hasRejections => rejected.isNotEmpty;
  bool get hasAccepted => accepted.isNotEmpty;
  bool get hasWarnings => warnings.isNotEmpty;
}

/// Чистая логика проверки лимитов материалов.
///
/// Не зависит от Flutter и легко тестируется. Используется как единственный
/// источник истины для ограничений количества, формата и длительности.
class MediaLimits {
  const MediaLimits._();

  static String extensionOf(String path) {
    final dot = path.lastIndexOf('.');
    if (dot < 0 || dot == path.length - 1) return '';
    return path.substring(dot + 1).toLowerCase();
  }

  /// Расширение материала.
  ///
  /// Берётся из [MediaAsset.name] (оригинальное имя файла), а не из
  /// [MediaAsset.path]: на Flutter Web `path` — это blob-URL без расширения
  /// (например `blob:http://localhost/…`), и определение формата по нему
  /// всегда возвращало бы пустую строку и отклоняло абсолютно все файлы.
  static String extensionOfAsset(MediaAsset asset) =>
      extensionOf(asset.name.isNotEmpty ? asset.name : asset.path);

  static bool isSupportedVideo(MediaAsset asset) =>
      AppConstants.supportedVideoExtensions.contains(extensionOfAsset(asset));

  static bool isSupportedImage(MediaAsset asset) =>
      AppConstants.supportedImageExtensions.contains(extensionOfAsset(asset));

  /// Проверяет пачку кандидатов относительно уже добавленных материалов.
  ///
  /// Возвращает принятые и отклонённые элементы с понятными причинами.
  static AddMediaResult validateBatch({
    required List<MediaAsset> existing,
    required List<MediaAsset> candidates,
  }) {
    final accepted = <MediaAsset>[];
    final rejected = <RejectedMedia>[];
    final warnings = <RejectedMedia>[];

    var videoCount = existing.where((a) => a.type == MediaType.video).length;
    var photoCount = existing.where((a) => a.type == MediaType.photo).length;
    final knownPaths = existing.map((a) => a.path).toSet();

    for (final candidate in candidates) {
      if (knownPaths.contains(candidate.path)) {
        // Молча пропускаем дубликаты — файл уже добавлен.
        continue;
      }

      if (candidate.type == MediaType.video) {
        if (!isSupportedVideo(candidate)) {
          rejected.add(
            RejectedMedia(
              name: candidate.name,
              reason:
                  'Формат видео не поддерживается. Разрешены MP4, MOV, M4V, '
                  'WebM, AVI, MKV, MPEG, MPG, 3GP.',
            ),
          );
          continue;
        }
        final duration = candidate.durationSeconds;
        if (duration != null &&
            duration > AppConstants.maxSingleVideo.inSeconds) {
          rejected.add(
            RejectedMedia(
              name: candidate.name,
              reason: 'Видео длиннее 10 минут и не может быть добавлено.',
            ),
          );
          continue;
        }
        if (videoCount >= AppConstants.maxVideos) {
          rejected.add(
            RejectedMedia(
              name: candidate.name,
              reason: 'Достигнут лимит видео: ${AppConstants.maxVideos}.',
            ),
          );
          continue;
        }
        videoCount++;
        accepted.add(candidate);
        knownPaths.add(candidate.path);
        if (duration == null) {
          // Не отклоняем: на устройстве не всегда можно прочитать метаданные
          // (например, контейнеры вроде AVI/MKV без готового превью).
          // Ограничение в 10 минут будет перепроверено после обработки на
          // backend — пользователю лишь показываем предупреждение.
          warnings.add(
            RejectedMedia(
              name: candidate.name,
              reason:
                  'Не удалось определить длительность видео. Ограничение '
                  '10 минут будет проверено после обработки.',
            ),
          );
        }
      } else {
        if (!isSupportedImage(candidate)) {
          rejected.add(
            RejectedMedia(
              name: candidate.name,
              reason:
                  'Формат изображения не поддерживается. Разрешены JPG, '
                  'JPEG, PNG, WebP, HEIC, HEIF, GIF, BMP, TIFF.',
            ),
          );
          continue;
        }
        if (photoCount >= AppConstants.maxPhotos) {
          rejected.add(
            RejectedMedia(
              name: candidate.name,
              reason: 'Достигнут лимит фотографий: ${AppConstants.maxPhotos}.',
            ),
          );
          continue;
        }
        photoCount++;
        accepted.add(candidate);
        knownPaths.add(candidate.path);
      }
    }

    return AddMediaResult(
      accepted: accepted,
      rejected: rejected,
      warnings: warnings,
    );
  }

  /// Ограничивает итоговую длительность 120 секундами.
  static int clampOutputSeconds(int seconds) {
    if (seconds < 1) return 1;
    if (seconds > AppConstants.maxOutputSeconds) {
      return AppConstants.maxOutputSeconds;
    }
    return seconds;
  }
}
