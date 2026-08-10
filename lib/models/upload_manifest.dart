/// Запись о ЗАГРУЖЕННОМ материале (§4D.3).
///
/// Ключ — стабильный [mediaId] (= id материала, не имя файла: два файла с
/// одинаковым названием не смешиваются). [objectPath] выдал сервер; он не
/// зависит от короткоживущего signed URL, поэтому переживает истечение ссылки
/// и повторные заходы на экран.
class UploadedAsset {
  const UploadedAsset({
    required this.mediaId,
    required this.objectPath,
    required this.sizeBytes,
    required this.uploadedAt,
  });

  final String mediaId;
  final String objectPath;
  final int sizeBytes;
  final DateTime uploadedAt;

  Map<String, dynamic> toJson() => {
    'mediaId': mediaId,
    'objectPath': objectPath,
    'sizeBytes': sizeBytes,
    'uploadedAt': uploadedAt.toIso8601String(),
  };

  factory UploadedAsset.fromJson(Map<String, dynamic> json) => UploadedAsset(
    mediaId: json['mediaId'] as String,
    objectPath: json['objectPath'] as String,
    sizeBytes: (json['sizeBytes'] as num?)?.toInt() ?? 0,
    uploadedAt:
        DateTime.tryParse(json['uploadedAt'] as String? ?? '') ??
        DateTime.now(),
  );
}

/// Манифест загрузки проекта: mediaId → загруженный объект (§4D.3).
///
/// Хранится в состоянии проекта и сериализуется, поэтому «Назад», перезагрузка
/// страницы и повторный рендер НЕ вызывают повторную загрузку: анализ и рендер
/// берут один и тот же уже загруженный объект.
class UploadManifest {
  const UploadManifest(this.assets);

  /// mediaId → запись.
  final Map<String, UploadedAsset> assets;

  static const UploadManifest empty = UploadManifest({});

  UploadedAsset? forMedia(String mediaId) => assets[mediaId];

  bool contains(String mediaId) => assets.containsKey(mediaId);

  /// objectPath по mediaId — для сборки запроса рендера/анализа.
  Map<String, String> get objectPaths => {
    for (final e in assets.entries) e.key: e.value.objectPath,
  };

  /// Добавляет/заменяет записи, оставляя прежние.
  UploadManifest withUploaded(Iterable<UploadedAsset> uploaded) =>
      UploadManifest({...assets, for (final u in uploaded) u.mediaId: u});

  /// Оставляет только записи для актуальных mediaId (удалённые материалы
  /// выпадают из манифеста).
  UploadManifest retainOnly(Set<String> mediaIds) => UploadManifest({
    for (final e in assets.entries)
      if (mediaIds.contains(e.key)) e.key: e.value,
  });

  Map<String, dynamic> toJson() => {
    'assets': [for (final u in assets.values) u.toJson()],
  };

  factory UploadManifest.fromJson(Map<String, dynamic>? json) {
    final list = (json?['assets'] as List?) ?? const [];
    final map = <String, UploadedAsset>{};
    for (final e in list) {
      final u = UploadedAsset.fromJson((e as Map).cast<String, dynamic>());
      map[u.mediaId] = u;
    }
    return UploadManifest(map);
  }
}
