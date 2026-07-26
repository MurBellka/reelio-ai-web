/// Разрешение на **прямую** загрузку одного материала в Cloud Storage.
///
/// Байты пользователя идут из браузера/приложения сразу в бакет по signed URL,
/// минуя backend. Сам URL живёт недолго ([expiresAt]) и не кэшируется.
class UploadTicket {
  const UploadTicket({
    required this.assetId,
    required this.objectPath,
    required this.uploadUrl,
    this.method = 'PUT',
    this.headers = const {},
    this.expiresAt,
  });

  /// Идентификатор материала, к которому относится разрешение.
  final String assetId;

  /// Путь объекта в бакете (§6 контракта), без `gs://`.
  final String objectPath;

  /// Signed URL для загрузки.
  final String uploadUrl;

  /// HTTP-метод загрузки (обычно `PUT`).
  final String method;

  /// Заголовки, которые обязан повторить клиент (иначе подпись не сойдётся).
  final Map<String, String> headers;

  final DateTime? expiresAt;

  bool get isExpired {
    final expires = expiresAt;
    if (expires == null) return false;
    return !expires.isAfter(DateTime.now().toUtc());
  }

  static UploadTicket? tryParse(Object? json) {
    if (json is! Map) return null;
    final assetId = json['assetId'] ?? json['id'];
    final uploadUrl = json['uploadUrl'] ?? json['url'];
    final objectPath = json['objectPath'];
    if (assetId is! String || uploadUrl is! String || objectPath is! String) {
      return null;
    }
    final rawHeaders = json['headers'];
    return UploadTicket(
      assetId: assetId,
      objectPath: objectPath,
      uploadUrl: uploadUrl,
      method: (json['method'] as String?)?.toUpperCase() ?? 'PUT',
      headers: rawHeaders is Map
          ? {
              for (final entry in rawHeaders.entries)
                '${entry.key}': '${entry.value}',
            }
          : const {},
      expiresAt: DateTime.tryParse(json['expiresAt'] as String? ?? '')?.toUtc(),
    );
  }
}

/// Прогресс прямой загрузки материалов — для полосы в UI.
class UploadProgress {
  const UploadProgress({
    required this.completedFiles,
    required this.totalFiles,
    this.currentFileName = '',
    this.currentFileFraction = 0,
  });

  /// Полностью загруженные файлы.
  final int completedFiles;

  final int totalFiles;

  /// Имя файла, который загружается сейчас.
  final String currentFileName;

  /// Прогресс внутри текущего файла, 0..1.
  final double currentFileFraction;

  static const UploadProgress empty = UploadProgress(
    completedFiles: 0,
    totalFiles: 0,
  );

  bool get isEmpty => totalFiles == 0;

  bool get isDone => totalFiles > 0 && completedFiles >= totalFiles;

  /// Общая доля загрузки 0..1: завершённые файлы плюс текущий.
  double get fraction {
    if (totalFiles <= 0) return 0;
    final done = completedFiles + currentFileFraction.clamp(0.0, 1.0);
    return (done / totalFiles).clamp(0.0, 1.0);
  }

  /// Подпись вида «Загрузка 2 из 5».
  String get label => totalFiles <= 0
      ? 'Загрузка материалов'
      : 'Загрузка ${(completedFiles + 1).clamp(1, totalFiles)} из $totalFiles';
}
