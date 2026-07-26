import 'edit_plan.dart';
import 'edit_request.dart';
import 'enums.dart';
import 'media_asset.dart';

/// Полное состояние проекта — сериализуется для локального хранения.
class ProjectState {
  const ProjectState({
    required this.id,
    required this.assets,
    required this.prompt,
    required this.style,
    required this.durationSeconds,
    required this.captions,
    required this.music,
    required this.stage,
    required this.updatedAt,
    this.plan,
    this.coverAssetId,
  });

  final String id;
  final List<MediaAsset> assets;
  final String prompt;
  final EditStyle style;
  final int durationSeconds;
  final CaptionSettings captions;
  final MusicSettings music;
  final EditPlan? plan;
  final AppStage stage;
  final String? coverAssetId;
  final DateTime updatedAt;

  factory ProjectState.empty(String id) => ProjectState(
    id: id,
    assets: const [],
    prompt: '',
    style: EditStyle.dynamicStyle,
    durationSeconds: 30,
    captions: CaptionSettings.defaults,
    music: MusicSettings.defaults,
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

  EditRequest toRequest() => EditRequest(
    assets: assets,
    prompt: prompt,
    style: style,
    durationSeconds: durationSeconds,
    captions: captions,
    music: music,
  );

  ProjectState copyWith({
    List<MediaAsset>? assets,
    String? prompt,
    EditStyle? style,
    int? durationSeconds,
    CaptionSettings? captions,
    MusicSettings? music,
    Object? plan = _noValue,
    AppStage? stage,
    Object? coverAssetId = _noValue,
  }) => ProjectState(
    id: id,
    assets: assets ?? this.assets,
    prompt: prompt ?? this.prompt,
    style: style ?? this.style,
    durationSeconds: durationSeconds ?? this.durationSeconds,
    captions: captions ?? this.captions,
    music: music ?? this.music,
    plan: plan == _noValue ? this.plan : plan as EditPlan?,
    stage: stage ?? this.stage,
    coverAssetId: coverAssetId == _noValue
        ? this.coverAssetId
        : coverAssetId as String?,
    updatedAt: DateTime.now(),
  );

  Map<String, dynamic> toJson() => {
    'id': id,
    'prompt': prompt,
    'style': style.storageValue,
    'durationSeconds': durationSeconds,
    'captions': captions.toJson(),
    'music': music.toJson(),
    'stage': stage.storageValue,
    'coverAssetId': coverAssetId,
    'updatedAt': updatedAt.toIso8601String(),
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
    music: MusicSettings.fromJson(
      (json['music'] as Map).cast<String, dynamic>(),
    ),
    stage: AppStage.fromStorage(json['stage'] as String? ?? 'onboarding'),
    coverAssetId: json['coverAssetId'] as String?,
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
