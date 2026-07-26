import 'dart:async';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import '../core/media_validation.dart';
import '../core/platform/media_bytes.dart';
import '../models/enums.dart';
import '../models/media_asset.dart';
import '../models/upload_ticket.dart';

/// Читает байты материала по локальному пути/blob-URL.
typedef MediaBytesReader = Future<Uint8List> Function(String path);

/// Ошибка прямой загрузки материалов в хранилище.
class MediaUploadException implements Exception {
  const MediaUploadException(this.message, {this.retryable = true});

  final String message;

  /// Имеет ли смысл повторить загрузку.
  final bool retryable;

  @override
  String toString() => message;
}

/// Загрузка отменена пользователем.
class MediaUploadCancelled implements Exception {
  const MediaUploadCancelled();

  @override
  String toString() => 'Загрузка отменена.';
}

/// Прямая загрузка исходников в Cloud Storage по signed URLs.
///
/// Байты идут из клиента в бакет напрямую, минуя backend: сервер только выдаёт
/// разрешения ([UploadTicket]) и никогда не видит содержимое файлов.
class MediaUploadService {
  MediaUploadService({
    http.Client? client,
    MediaBytesReader? readBytes,
    this.timeout = const Duration(minutes: 10),
    this.chunkSize = 256 * 1024,
  }) : _client = client ?? http.Client(),
       _ownsClient = client == null,
       _readBytes = readBytes ?? readMediaBytes;

  final http.Client _client;
  final bool _ownsClient;
  final MediaBytesReader _readBytes;

  /// Таймаут загрузки одного файла.
  final Duration timeout;

  /// Размер порции при отправке — определяет частоту обновления прогресса.
  final int chunkSize;

  /// MIME-тип материала по расширению — его же подписывает сервер в ticket'е.
  static String contentTypeFor(MediaAsset asset) {
    final ext = MediaLimits.extensionOfAsset(asset);
    return switch (ext) {
      'mp4' || 'm4v' => 'video/mp4',
      'mov' => 'video/quicktime',
      'webm' => 'video/webm',
      'avi' => 'video/x-msvideo',
      'mkv' => 'video/x-matroska',
      'mpeg' || 'mpg' => 'video/mpeg',
      '3gp' => 'video/3gpp',
      'jpg' || 'jpeg' => 'image/jpeg',
      'png' => 'image/png',
      'webp' => 'image/webp',
      'heic' => 'image/heic',
      'heif' => 'image/heif',
      'tiff' || 'tif' => 'image/tiff',
      _ => asset.type == MediaType.video ? 'video/mp4' : 'image/jpeg',
    };
  }

  /// MIME-типы всех материалов — для запроса разрешений на загрузку.
  static Map<String, String> contentTypesOf(List<MediaAsset> assets) => {
    for (final asset in assets) asset.id: contentTypeFor(asset),
  };

  /// Загружает материалы по выданным разрешениям.
  ///
  /// Возвращает фактические размеры файлов по `assetId` — они уходят в
  /// `RenderRequest.assets[].sizeBytes`.
  Future<Map<String, int>> uploadAll({
    required List<MediaAsset> assets,
    required List<UploadTicket> tickets,
    void Function(UploadProgress progress)? onProgress,
    bool Function()? isCancelled,
  }) async {
    final ticketsById = {for (final t in tickets) t.assetId: t};
    final queue = [
      for (final asset in assets)
        if (ticketsById.containsKey(asset.id)) asset,
    ];
    final total = queue.length;
    final sizes = <String, int>{};

    onProgress?.call(UploadProgress(completedFiles: 0, totalFiles: total));

    for (var i = 0; i < total; i++) {
      final asset = queue[i];
      final ticket = ticketsById[asset.id]!;
      _throwIfCancelled(isCancelled);

      if (ticket.isExpired) {
        throw const MediaUploadException(
          'Срок действия ссылки на загрузку истёк. Попробуйте ещё раз.',
        );
      }

      void report(double fraction) => onProgress?.call(
        UploadProgress(
          completedFiles: i,
          totalFiles: total,
          currentFileName: asset.name,
          currentFileFraction: fraction,
        ),
      );

      final Uint8List bytes;
      try {
        bytes = await _readBytes(asset.path);
      } catch (_) {
        throw MediaUploadException(
          'Не удалось прочитать файл «${asset.name}». '
          'Выберите материал заново.',
          retryable: false,
        );
      }

      await _upload(
        ticket: ticket,
        bytes: bytes,
        contentType: contentTypeFor(asset),
        onSent: (sent) => report(bytes.isEmpty ? 1 : sent / bytes.length),
        isCancelled: isCancelled,
        fileName: asset.name,
      );

      sizes[asset.id] = bytes.length;
      onProgress?.call(
        UploadProgress(
          completedFiles: i + 1,
          totalFiles: total,
          currentFileName: asset.name,
          currentFileFraction: 0,
        ),
      );
    }

    return sizes;
  }

  Future<void> _upload({
    required UploadTicket ticket,
    required Uint8List bytes,
    required String contentType,
    required String fileName,
    required void Function(int sent) onSent,
    bool Function()? isCancelled,
  }) async {
    final request = http.StreamedRequest(
      ticket.method,
      Uri.parse(ticket.uploadUrl),
    )..contentLength = bytes.length;
    request.headers['Content-Type'] = contentType;
    request.headers.addAll(ticket.headers);

    final responseFuture = _client.send(request);
    // Ответ уже может прийти (ошибкой) до конца отправки — не теряем её.
    unawaited(responseFuture.catchError((Object _) => _emptyResponse()));

    try {
      var offset = 0;
      while (offset < bytes.length) {
        _throwIfCancelled(isCancelled);
        final end = math.min(offset + chunkSize, bytes.length);
        request.sink.add(Uint8List.sublistView(bytes, offset, end));
        offset = end;
        onSent(offset);
        // Отдаём управление, чтобы сокет успевал отправлять порции.
        await Future<void>.delayed(Duration.zero);
      }
      // Закрытие только сигнализирует конец тела; ждать надо ответ, иначе
      // получаем взаимную блокировку с потребителем потока.
      request.sink.close().ignore();
    } on MediaUploadCancelled {
      request.sink.close().ignore();
      rethrow;
    }

    final http.StreamedResponse response;
    try {
      response = await responseFuture.timeout(timeout);
    } on TimeoutException {
      throw MediaUploadException(
        'Загрузка «$fileName» не уложилась во время ожидания.',
      );
    } catch (_) {
      throw MediaUploadException(
        'Не удалось загрузить «$fileName». Проверьте подключение.',
      );
    }

    // Хранилище отвечает пустым телом; тело всё равно нужно вычитать.
    await response.stream.drain<void>();

    if (response.statusCode >= 400) {
      final expired = response.statusCode == 403 || response.statusCode == 401;
      throw MediaUploadException(
        expired
            ? 'Ссылка на загрузку «$fileName» истекла. Попробуйте ещё раз.'
            : 'Хранилище отклонило загрузку «$fileName» '
                  '(${response.statusCode}).',
        retryable: response.statusCode >= 500 || expired,
      );
    }
  }

  static void _throwIfCancelled(bool Function()? isCancelled) {
    if (isCancelled?.call() ?? false) throw const MediaUploadCancelled();
  }

  static http.StreamedResponse _emptyResponse() =>
      http.StreamedResponse(const Stream<List<int>>.empty(), 599);

  void close() {
    if (_ownsClient) _client.close();
  }
}
