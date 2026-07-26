import 'enums.dart';

/// Выбранный пользователем материал (видео или фото).
class MediaAsset {
  const MediaAsset({
    required this.id,
    required this.path,
    required this.name,
    required this.type,
    this.durationSeconds,
    this.width,
    this.height,
  });

  final String id;
  final String path;
  final String name;
  final MediaType type;

  /// Длительность видео в секундах. Для фото — `null`.
  final double? durationSeconds;

  /// Исходные пиксельные размеры (если удалось определить на клиенте).
  final int? width;
  final int? height;

  bool get isVideo => type == MediaType.video;
  bool get isPhoto => type == MediaType.photo;

  /// Наибольшая сторона исходника — прокси «вертикальной» высоты для 9:16.
  int? get maxSide {
    if (width == null || height == null) return null;
    return width! > height! ? width! : height!;
  }

  MediaAsset copyWith({String? name, int? width, int? height}) => MediaAsset(
    id: id,
    path: path,
    name: name ?? this.name,
    type: type,
    durationSeconds: durationSeconds,
    width: width ?? this.width,
    height: height ?? this.height,
  );

  Map<String, dynamic> toJson() => {
    'id': id,
    'path': path,
    'name': name,
    'type': type.storageValue,
    'durationSeconds': durationSeconds,
    'width': width,
    'height': height,
  };

  factory MediaAsset.fromJson(Map<String, dynamic> json) => MediaAsset(
    id: json['id'] as String,
    path: json['path'] as String,
    name: json['name'] as String,
    type: MediaType.fromStorage(json['type'] as String),
    durationSeconds: (json['durationSeconds'] as num?)?.toDouble(),
    width: (json['width'] as num?)?.toInt(),
    height: (json['height'] as num?)?.toInt(),
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
