import 'dart:async';

import '../models/edit_plan.dart';
import '../models/edit_request.dart';
import 'ai_editing_service.dart';
import 'analysis_api_client.dart';

/// Загружает материалы запроса и возвращает assetId → objectPath.
///
/// Вынесено интерфейсом, чтобы планировщик тестировался без реального аплоада.
typedef AssetUploader =
    Future<Map<String, String>> Function(EditRequest request);

/// Планировщик v2 через beta backend (§4C.6): загрузка материалов →
/// `POST /analysis` → опрос статуса → `POST /analysis/{id}/plan` → EditPlan v2.
///
/// В отличие от v1 `/edit-plan`, план в v2 строится из анализа загруженных
/// материалов. Ни analysis, ни render не ходят на v1 — только на beta URL
/// (§4C.7, §4C.8, без смешивания).
class BetaAiEditingService implements AiEditingService {
  BetaAiEditingService({
    required this.client,
    required this.projectId,
    required this.uploadAssets,
    this.pollInterval = const Duration(seconds: 2),
    this.pollTimeout = const Duration(minutes: 5),
  });

  final AnalysisApiClient client;
  final String projectId;
  final AssetUploader uploadAssets;
  final Duration pollInterval;
  final Duration pollTimeout;

  bool _cancelled = false;

  @override
  bool get isDemo => false;

  @override
  void cancel() {
    _cancelled = true;
  }

  @override
  Future<EditPlan> createEditPlan(EditRequest request) async {
    _cancelled = false;

    // 1. Материалы должны быть в бакете, чтобы beta их проанализировала.
    final objectPaths = await uploadAssets(request);
    _throwIfCancelled();

    // 2. Создаём анализ по путям, выданным сервером.
    final assets = [
      for (final asset in request.assets)
        if (objectPaths[asset.id] != null)
          {
            'id': asset.id,
            'type': asset.type.storageValue,
            'objectPath': objectPaths[asset.id],
            if (asset.durationSeconds != null)
              'durationSeconds': asset.durationSeconds,
          },
    ];
    if (assets.isEmpty) {
      throw const AiEditingException(
        'Не удалось загрузить материалы для анализа.',
      );
    }

    final analysisId = await client.createAnalysis(
      projectId: projectId,
      assets: assets,
    );

    // 3. Ждём завершения анализа.
    final deadline = DateTime.now().add(pollTimeout);
    var status = await client.getStatus(analysisId);
    while (!status.isTerminal) {
      _throwIfCancelled();
      if (DateTime.now().isAfter(deadline)) {
        throw const AiEditingException(
          'Анализ идёт слишком долго. Попробуйте ещё раз.',
        );
      }
      await Future<void>.delayed(pollInterval);
      _throwIfCancelled();
      status = await client.getStatus(analysisId);
    }
    if (!status.isSucceeded) {
      throw AiEditingException(
        status.error ?? 'Не удалось разобрать материалы. Попробуйте ещё раз.',
      );
    }

    // 4. Собираем EditPlan v2 из готового анализа.
    return client.getPlan(
      analysisId,
      prompt: request.prompt,
      targetDurationSeconds: request.durationSeconds,
    );
  }

  void _throwIfCancelled() {
    if (_cancelled) throw const AiEditingException('Запрос отменён.');
  }
}
