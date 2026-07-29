import '../models/media_asset.dart';
import '../models/render_request.dart';
import '../models/upload_manifest.dart';
import '../models/upload_ticket.dart';
import 'media_upload_service.dart';
import 'render_api_client.dart';

/// Результат согласования загрузки: пути объектов для ВСЕХ материалов и список
/// тех, что были загружены в этот раз (их и записывают в манифест проекта).
typedef EnsureUploadedResult = ({
  Map<String, String> objectPaths,
  List<UploadedAsset> uploaded,
});

/// Единая координация загрузки материалов (§4D.3).
///
/// Один материал = один стабильный mediaId = один серверный objectPath.
/// Загружаются ТОЛЬКО отсутствующие в манифесте материалы; уже загруженные
/// переиспользуются и analysis, и render'ом — без повторного трафика. Signed
/// URL короткоживущие, но objectPath стабилен, поэтому истечение ссылки
/// решается новым запросом /uploads БЕЗ смены mediaId.
class UploadCoordinator {
  UploadCoordinator({required this.api, required this.uploader, this.now});

  final RenderApiClient api;
  final MediaUploadService uploader;
  final DateTime Function()? now;

  DateTime get _now => (now ?? DateTime.now)();

  /// Гарантирует, что все [assets] загружены. Возвращает objectPath для каждого
  /// и записи о вновь загруженных.
  ///
  /// [isCancelled] — отменённую незавершённую загрузку можно безопасно начать
  /// заново: уже загруженные материалы останутся в манифесте и не поедут снова.
  Future<EnsureUploadedResult> ensureUploaded({
    required List<MediaAsset> assets,
    required UploadManifest manifest,
    required String ownerUid,
    required String projectId,
    void Function(UploadProgress)? onProgress,
    bool Function()? isCancelled,
  }) async {
    final objectPaths = <String, String>{};
    final toUpload = <MediaAsset>[];

    // Переиспользуем всё, что уже загружено (по стабильному mediaId).
    for (final asset in assets) {
      final existing = manifest.forMedia(asset.id);
      if (existing != null) {
        objectPaths[asset.id] = existing.objectPath;
      } else {
        toUpload.add(asset);
      }
    }

    final uploaded = <UploadedAsset>[];
    if (toUpload.isEmpty) {
      return (objectPaths: objectPaths, uploaded: uploaded);
    }

    // Пути ПРЕДЛАГАЕМ с uid владельца; авторитетным становится тот, что вернул
    // сервер. Для того же mediaId сервер отдаёт тот же путь — mediaId не меняется.
    final proposed = [
      for (final asset in toUpload)
        RenderAsset(
          id: asset.id,
          type: asset.type,
          objectPath: RenderAsset.proposedSourcePath(
            ownerUid: ownerUid,
            projectId: projectId,
            asset: asset,
          ),
          durationSeconds: asset.durationSeconds,
          width: asset.width,
          height: asset.height,
        ),
    ];

    final tickets = await api.requestUploadTickets(
      projectId: projectId,
      assets: proposed,
      contentTypes: MediaUploadService.contentTypesOf(toUpload),
    );
    final ticketPaths = <String, String>{
      for (final UploadTicket t in tickets) t.assetId: t.objectPath,
    };

    final sizes = await uploader.uploadAll(
      assets: toUpload,
      tickets: tickets,
      onProgress: onProgress ?? (_) {},
      isCancelled: isCancelled ?? () => false,
    );

    final uploadedAt = _now;
    for (final asset in toUpload) {
      final objectPath = ticketPaths[asset.id];
      if (objectPath == null || objectPath.isEmpty) continue;
      objectPaths[asset.id] = objectPath;
      uploaded.add(
        UploadedAsset(
          mediaId: asset.id,
          objectPath: objectPath,
          sizeBytes: sizes[asset.id] ?? 0,
          uploadedAt: uploadedAt,
        ),
      );
    }
    return (objectPaths: objectPaths, uploaded: uploaded);
  }
}
