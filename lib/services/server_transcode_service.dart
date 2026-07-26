import '../core/constants.dart';
import '../core/media_validation.dart';
import '../models/media_asset.dart';

/// Заглушка будущего backend-сервиса перекодирования медиа.
///
/// Клиент принимает все форматы из [AppConstants.supportedVideoExtensions] и
/// [AppConstants.supportedImageExtensions], но часть из них
/// ([AppConstants.serverTranscodeExtensions] — AVI, MKV, HEIC, HEIF, MPEG,
/// MPG, 3GP, TIFF) не декодируется в браузере и не всегда — во встроенном
/// плеере на устройстве. На клиенте для таких файлов вместо предпросмотра
/// показывается карточка-заглушка (`UnsupportedPreviewPlaceholder`).
///
/// Приводить их к совместимому формату (H.264/AAC MP4, JPEG) должен backend
/// через FFmpeg до начала обработки проекта. Этот класс — точка расширения
/// под будущий вызов такого API; сейчас он ничего не отправляет в сеть.
class ServerTranscodeService {
  const ServerTranscodeService();

  /// `true`, если материал потребует серверной перекодировки перед показом
  /// финального превью или обработкой (см. [AppConstants.serverTranscodeExtensions]).
  bool requiresTranscode(MediaAsset asset) {
    final ext = MediaLimits.extensionOfAsset(asset);
    return AppConstants.serverTranscodeExtensions.contains(ext);
  }

  /// TODO(backend): заменить на реальный запрос к сервису конвертации
  /// (например, POST /media/transcode с id проекта и материала), когда
  /// появится backend. Сейчас — заглушка, ничего не отправляет в сеть.
  Future<void> requestTranscode(MediaAsset asset) async {
    throw UnimplementedError(
      'Серверная перекодировка ещё не реализована: backend появится позже. '
      'Файл «${asset.name}» будет обработан без предварительной '
      'перекодировки.',
    );
  }
}
