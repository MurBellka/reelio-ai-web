import 'enums.dart';

/// Выбранный пользователем материал (видео или фото).
class MediaAsset {
  const MediaAsset({
    required this.id,
    required this.path,
    required this.name,
    required this.type,
    this.durationSeconds,
  });

  final String id;
  final String path;
  final String name;
  final MediaType type;

  /// Длительность видео в секундах. Для фото — `null`.
  final double? durationSeconds;

  bool get isVideo => type == MediaType.video;
  bool get isPhoto => type == MediaType.photo;

  MediaAsset copyWith({String? name}) => MediaAsset(
    id: id,
    path: path,
    name: name ?? this.name,
    type: type,
    durationSeconds: durationSeconds,
  );

  Map<String, dynamic> toJson() => {
    'id': id,
    'path': path,
    'name': name,
    'type': type.storageValue,
    'durationSeconds': durationSeconds,
  };

  factory MediaAsset.fromJson(Map<String, dynamic> json) => MediaAsset(
    id: json['id'] as String,
    path: json['path'] as String,
    name: json['name'] as String,
    type: MediaType.fromStorage(json['type'] as String),
    durationSeconds: (json['durationSeconds'] as num?)?.toDouble(),
  );

  @override
  bool operator ==(Object other) =>
      other is MediaAsset &&
      other.id == id &&
      other.path == path &&
      other.type == type;

  @override
  int get hashCode => Object.hash(id, path, type);
}
