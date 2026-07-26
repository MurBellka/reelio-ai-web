import 'constants.dart';
import 'media_validation.dart';
import '../models/enums.dart';

/// Определяет тип материала (фото/видео) без обращения к платформе —
/// удобно для юнит-тестов и переиспользуется на web и mobile.
///
/// Расширение файла — приоритетный и единственный надёжный источник:
/// на iPhone и в браузерах MIME-тип нередко пуст или не соответствует
/// содержимому (см. требование не проверять файл только по MIME).
class MediaTypeDetector {
  const MediaTypeDetector._();

  static MediaType detect({required String name, String? mimeType}) {
    final ext = MediaLimits.extensionOf(name);
    if (AppConstants.supportedVideoExtensions.contains(ext)) {
      return MediaType.video;
    }
    if (AppConstants.supportedImageExtensions.contains(ext)) {
      return MediaType.photo;
    }
    final mime = mimeType ?? '';
    if (mime.startsWith('video/')) return MediaType.video;
    if (mime.startsWith('image/')) return MediaType.photo;
    // Расширение неизвестно, MIME пуст или не распознан — по умолчанию
    // считаем фото; формат всё равно будет проверен и, если не
    // поддерживается, файл отклонится в MediaLimits.validateBatch.
    return MediaType.photo;
  }
}
