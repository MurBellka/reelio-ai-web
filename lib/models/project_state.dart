import 'edit_plan.dart';
import 'edit_request.dart';
import 'enums.dart';
import 'media_asset.dart';
import 'upload_manifest.dart';

/// Полное состояние проекта — сериализуется для локального хранения.
class ProjectState {
  const ProjectState({
    required this.id,
    required this.assets,
    required this.prompt,
    required this.style,
    required this.durationSeconds,
    required this.captions,
    required this.audio,
    required this.stage,
    required this.updatedAt,
    this.plan,
    this.coverAssetId,
    this.uploadManifest = UploadManifest.empty,
  });

  final String id;
  final List<MediaAsset> assets;
  final String prompt;
  final EditStyle style;
  final int durationSeconds;
  final CaptionSettings captions;
  final AudioSettings audio;
  final EditPlan? plan;
  final AppStage stage;
  final String? coverAssetId;
  final DateTime updatedAt;

  /// Загруженные материалы (§4D.3): analysis и render берут их отсюда, не
  /// загружая повторно.
  final UploadManifest uploadManifest;

  factory ProjectState.empty(String id) => ProjectState(
    id: id,
    assets: const [],
    prompt: '',
    style: EditStyle.dynamicStyle,
    durationSeconds: 30,
    captions: CaptionSettings.defaults,
    audio: AudioSettings.defaults,
    stage: AppStage.onboarding,
    updatedAt: DateTime.now(),
  );

  bool get isEmpty => assets.isEmpty && prompt.isEmpty && plan == null;

  List<MediaAsset> get videos =>
      assets.where((a) => a.type == MediaType.video).toList();
  List<MediaAsset> get photos =>
      assets.where((a) => a.type == MediaType.photo).toList();

  int get videoCount => videos.length;
  int get photoCount => photos.length;

  /// Наибольшая сторона среди исходников — прокси максимального доступного
  /// вертикального разрешения экспорта. `null`, если размеры неизвестны.
  int? get sourceMaxHeight {
    int? best;
    for (final a in assets) {
      final side = a.maxSide;
      if (side != null && (best == null || side > best)) best = side;
    }
    return best;
  }

  EditRequest toRequest() => EditRequest(
    assets: assets,
    prompt: prompt,
    style: style,
    durationSeconds: durationSeconds,
    captions: captions,
    audio: audio,
  );

  ProjectState copyWith({
    List<MediaAsset>? assets,
    String? prompt,
    EditStyle? style,
    int? durationSeconds,
    CaptionSettings? captions,
    AudioSettings? audio,
    Object? plan = _noValue,
    AppStage? stage,
    Object? coverAssetId = _noValue,
    UploadManifest? uploadManifest,
  }) => ProjectState(
    id: id,
    assets: assets ?? this.assets,
    prompt: prompt ?? this.prompt,
    style: style ?? this.style,
    durationSeconds: durationSeconds ?? this.durationSeconds,
    captions: captions ?? this.captions,
    audio: audio ?? this.audio,
    plan: plan == _noValue ? this.plan : plan as EditPlan?,
    stage: stage ?? this.stage,
    coverAssetId: coverAssetId == _noValue
        ? this.coverAssetId
        : coverAssetId as String?,
    uploadManifest: uploadManifest ?? this.uploadManifest,
    updatedAt: DateTime.now(),
  );

  Map<String, dynamic> toJson() => {
    'id': id,
    'prompt': prompt,
    'style': style.storageValue,
    'durationSeconds': durationSeconds,
    'captions': captions.toJson(),
    'audio': audio.toJson(),
    'stage': stage.storageValue,
    'coverAssetId': coverAssetId,
    'updatedAt': updatedAt.toIso8601String(),
    'uploadManifest': uploadManifest.toJson(),
    'assets': assets.map((a) => a.toJson()).toList(),
    'plan': plan?.toJson(),
  };

  factory ProjectState.fromJson(Map<String, dynamic> json) => ProjectState(
    id: json['id'] as String,
    prompt: json['prompt'] as String? ?? '',
    style: EditStyle.fromStorage(json['style'] as String? ?? 'dynamicStyle'),
    durationSeconds: (json['durationSeconds'] as num?)?.toInt() ?? 30,
    captions: CaptionSettings.fromJson(
      (json['captions'] as Map).cast<String, dynamic>(),
    ),
    audio: AudioSettings.fromJson(
      (json['audio'] as Map?)?.cast<String, dynamic>(),
    ),
    stage: AppStage.fromStorage(json['stage'] as String? ?? 'onboarding'),
    coverAssetId: json['coverAssetId'] as String?,
    uploadManifest: UploadManifest.fromJson(
      (json['uploadManifest'] as Map?)?.cast<String, dynamic>(),
    ),
    updatedAt:
        DateTime.tryParse(json['updatedAt'] as String? ?? '') ?? DateTime.now(),
    assets: (json['assets'] as List? ?? [])
        .map((e) => MediaAsset.fromJson((e as Map).cast<String, dynamic>()))
        .toList(),
    plan: json['plan'] == null
        ? null
        : EditPlan.fromJson((json['plan'] as Map).cast<String, dynamic>()),
  );

  static const Object _noValue = Object();
}
