import '../core/media_validation.dart';
import 'edit_plan.dart';
import 'enums.dart';
import 'media_asset.dart';
import 'project_state.dart';
import 'render_job.dart';

/// Идентификаторы проекта/материала/задачи в контракте: `^[A-Za-z0-9_-]{1,64}$`.
final RegExp kRenderIdPattern = RegExp(r'^[A-Za-z0-9_-]{1,64}$');

/// Материал в запросе рендера (§3 контракта).
///
/// Сервер работает **только** с [objectPath] в Cloud Storage; локальный путь
/// клиента в рендер не попадает.
class RenderAsset {
  const RenderAsset({
    required this.id,
    required this.type,
    required this.objectPath,
    this.sizeBytes,
    this.durationSeconds,
    this.width,
    this.height,
    this.checksumCrc32c,
  });

  final String id;
  final MediaType type;

  /// Путь объекта внутри бакета, без `gs://`, всегда под
  /// `projects/{projectId}/` (§6).
  final String objectPath;

  final int? sizeBytes;
  final double? durationSeconds;
  final int? width;
  final int? height;
  final String? checksumCrc32c;

  /// Строит запись по локальному материалу, вычисляя путь объекта по §6.
  /// Собирает запись для запроса.
  ///
  /// [objectPath] — обязателен и должен быть тем, что выдал backend в ответе
  /// `/uploads`. Клиент не изобретает пути: схему хранения знает только
  /// сервер, и в неё входит проверенный uid владельца.
  factory RenderAsset.fromMediaAsset(
    MediaAsset asset, {
    required String objectPath,
    int? sizeBytes,
  }) => RenderAsset(
    id: asset.id,
    type: asset.type,
    objectPath: objectPath,
    sizeBytes: sizeBytes,
    durationSeconds: asset.durationSeconds,
    width: asset.width,
    height: asset.height,
  );

  /// Путь, ПРЕДЛАГАЕМЫЙ в запросе `/uploads`: `users/{uid}/projects/{id}/…`.
  ///
  /// Только предложение — авторитетным считается путь из ответа сервера.
  /// Имя файла берётся из стабильного идентификатора материала, а не из
  /// пользовательского: так кириллица, пробелы и два одинаковых названия не
  /// создают ни коллизий, ни недопустимых символов в пути.
  static String proposedSourcePath({
    required String ownerUid,
    required String projectId,
    required MediaAsset asset,
  }) {
    final ext = MediaLimits.extensionOfAsset(asset);
    final safeExt = ext.isNotEmpty
        ? ext
        : (asset.type == MediaType.video ? 'mp4' : 'jpg');
    return 'users/$ownerUid/projects/$projectId/sources/${asset.id}.$safeExt';
  }

  Map<String, dynamic> toJson() => {
    'id': id,
    'type': type.storageValue,
    'objectPath': objectPath,
    if (sizeBytes != null) 'sizeBytes': sizeBytes,
    if (durationSeconds != null) 'durationSeconds': durationSeconds,
    if (width != null) 'width': width,
    if (height != null) 'height': height,
    if (checksumCrc32c != null) 'checksumCrc32c': checksumCrc32c,
  };
}

/// Запрос на рендер (§3 контракта).
class RenderRequest {
  const RenderRequest({
    required this.projectId,
    required this.plan,
    required this.assets,
    this.contractVersion = kRenderContractVersion,
    this.exportResolution,
    this.exportFps,
    this.idempotencyKey,
  });

  final int contractVersion;
  final String projectId;
  final EditPlan plan;
  final List<RenderAsset> assets;

  /// Перекрывает `plan.export` (§3). `maximumAvailable` резолвится на сервере.
  final ExportResolution? exportResolution;
  final int? exportFps;

  final String? idempotencyKey;

  Map<String, dynamic> toJson() => {
    'contractVersion': contractVersion,
    'projectId': projectId,
    'plan': plan.toJson(),
    'assets': assets.map((a) => a.toJson()).toList(),
    if (exportResolution != null || exportFps != null)
      'export': {
        if (exportResolution != null)
          'resolution': exportResolution!.storageValue,
        if (exportFps != null) 'fps': exportFps,
      },
    if (idempotencyKey != null) 'idempotencyKey': idempotencyKey,
  };

  /// Собирает запрос из состояния проекта.
  ///
  /// Бросает [RenderRequestException] с понятным сообщением, если проект ещё
  /// не готов к рендеру (нет плана, нет материалов, клип ссылается на
  /// удалённый материал).
  /// Собирает запрос из состояния проекта.
  ///
  /// [objectPathsByAssetId] — пути, ВЫДАННЫЕ backend'ом в ответе `/uploads`.
  /// Без них запрос не собирается: путь, придуманный клиентом, будет отвергнут
  /// проверкой каталога, и пользователь потеряет время уже после загрузки.
  factory RenderRequest.fromProject(
    ProjectState project, {
    required Map<String, String> objectPathsByAssetId,
    Map<String, int> sizesByAssetId = const {},
    String? idempotencyKey,
  }) {
    final plan = project.plan;
    if (plan == null) {
      throw const RenderRequestException(
        'Монтажный план ещё не готов — сначала дождитесь обработки.',
      );
    }
    if (project.assets.isEmpty) {
      throw const RenderRequestException('Нет материалов для рендера.');
    }
    if (!kRenderIdPattern.hasMatch(project.id)) {
      throw const RenderRequestException(
        'Некорректный идентификатор проекта. Создайте проект заново.',
      );
    }

    final assetsById = {for (final a in project.assets) a.id: a};
    final assetsByPath = {for (final a in project.assets) a.path: a};

    // Клип обязан ссылаться на материал через mediaId (§2, инвариант 2).
    // Планы, собранные до появления mediaId, дополняем по локальному пути.
    final clips = <EditClip>[];
    final usedAssetIds = <String>{};
    for (final clip in plan.clips) {
      // Экспорт адресует материал по серверному mediaId; filePath — только
      // клиентский резерв для старых черновиков и в /render не уходит.
      final asset =
          assetsById[clip.mediaId] ??
          (clip.filePath != null ? assetsByPath[clip.filePath] : null);
      if (asset == null) {
        throw RenderRequestException(
          'Фрагмент «${clip.sourceName.isEmpty ? clip.id : clip.sourceName}» '
          'ссылается на материал, которого больше нет в проекте.',
        );
      }
      usedAssetIds.add(asset.id);
      clips.add(clip.withMediaId(asset.id));
    }
    if (clips.isEmpty) {
      throw const RenderRequestException(
        'В монтажном плане нет ни одного фрагмента.',
      );
    }

    // Отправляем только те материалы, которые реально используются планом.
    // Каждый сопоставляется с загруженным объектом по стабильному id: имя
    // файла для этого не годится — два файла могут называться одинаково.
    final assets = <RenderAsset>[];
    final missing = <String>[];
    for (final asset in project.assets) {
      if (!usedAssetIds.contains(asset.id)) continue;
      final objectPath = objectPathsByAssetId[asset.id];
      if (objectPath == null || objectPath.isEmpty) {
        missing.add(asset.name.isEmpty ? asset.id : asset.name);
        continue;
      }
      assets.add(
        RenderAsset.fromMediaAsset(
          asset,
          objectPath: objectPath,
          sizeBytes: sizesByAssetId[asset.id],
        ),
      );
    }

    if (missing.isNotEmpty) {
      // Так выглядит проект, собранный до смены схемы хранения: материалы
      // выбраны, но на сервер в нынешнем виде не загружены. Восстановить их
      // самим нельзя — честнее попросить загрузить заново, чем отправить
      // заведомо неверный путь и получить отказ после долгой выгрузки.
      throw RenderRequestException(
        'Материалы нужно загрузить заново: ${missing.take(3).join(', ')}'
        '${missing.length > 3 ? ' и ещё ${missing.length - 3}' : ''}. '
        'Вернитесь к шагу «Материалы» и добавьте их снова.',
      );
    }

    return RenderRequest(
      projectId: project.id,
      plan: plan.copyWith(clips: clips),
      assets: assets,
      exportResolution: plan.export.resolution,
      exportFps: plan.export.fps,
      idempotencyKey: idempotencyKey,
    );
  }
}

/// Проект не готов к отправке на рендер.
class RenderRequestException implements Exception {
  const RenderRequestException(this.message);
  final String message;

  @override
  String toString() => message;
}
