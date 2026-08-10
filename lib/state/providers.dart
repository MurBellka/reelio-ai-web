import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';

import '../core/app_config.dart';
import '../core/media_validation.dart';
import '../models/edit_plan.dart';
import '../models/edit_request.dart';
import '../models/enums.dart';
import '../models/export_settings.dart';
import '../models/media_asset.dart';
import '../models/project_state.dart';
import '../models/text_overlay.dart';
import '../models/transition.dart';
import '../models/upload_manifest.dart';
import '../models/upload_ticket.dart' show UploadProgress;
import '../services/ai_editing_service.dart';
import '../services/analysis_api_client.dart';
import 'auth_providers.dart';
import '../services/beta_ai_editing_service.dart';
import '../services/gemini_ai_editing_service.dart';
import '../services/media_picker_service.dart';
import 'render_providers.dart';
import '../services/storage_service.dart';
import '../services/video_export_service.dart';

final uuidProvider = Provider<Uuid>((_) => const Uuid());

final storageServiceProvider = Provider<StorageService>(
  (_) => const StorageService(),
);

/// Клиент analysis API беты (§4C.4). Токены берутся свежими на каждый запрос.
final analysisApiClientProvider = Provider<AnalysisApiClient>((ref) {
  final client = AnalysisApiClient(
    baseUrl: AppConfig.betaBackendBaseUrl,
    tokens: ref.watch(authTokensProvider),
  );
  ref.onDispose(client.close);
  return client;
});

/// Выбор планировщика (§4C.2, §4C.7, §4C.8):
///   • флаг v2 выключен → прежний v1 `/edit-plan` (Gemini), поведение как было;
///   • флаг v2 включён без beta URL → недоступность беты (понятная ошибка);
///   • флаг v2 включён с beta URL → analysis-пайплайн на beta, без смешивания;
///   • backend'а нет вовсе → мок (Demo Mode).
final aiServiceProvider = Provider<AiEditingService>((ref) {
  if (AppConfig.betaUnavailable) {
    return const _BetaUnavailableService();
  }
  if (AppConfig.isV2Active) {
    final service = BetaAiEditingService(
      client: ref.watch(analysisApiClientProvider),
      projectId: ref.read(projectProvider).id,
      uploadAssets: (request, {onProgress, isCancelled}) => _uploadForBeta(
        ref,
        request,
        onProgress: onProgress,
        isCancelled: isCancelled,
      ),
    );
    ref.onDispose(service.cancel);
    return service;
  }
  if (AppConfig.hasBackend) {
    // v1: /edit-plan защищён так же, как остальной API; без токенов — 401.
    final service = GeminiAiEditingService(
      tokens: ref.watch(authTokensProvider),
    );
    ref.onDispose(service.cancel);
    return service;
  }
  return const MockAiEditingService();
});

/// Загрузка материалов для анализа beta через ЕДИНЫЙ координатор (§4D.3):
/// уже загруженные материалы переиспользуются, новые грузятся один раз и
/// попадают в манифест — рендер потом не грузит их повторно.
Future<Map<String, String>> _uploadForBeta(
  Ref ref,
  EditRequest request, {
  void Function(UploadProgress progress)? onProgress,
  bool Function()? isCancelled,
}) async {
  final uid = ref.read(currentUidProvider) ?? '';
  final project = ref.read(projectProvider);
  final coordinator = ref.read(uploadCoordinatorProvider);
  final result = await coordinator.ensureUploaded(
    assets: request.assets,
    manifest: project.uploadManifest,
    ownerUid: uid,
    projectId: project.id,
    onProgress: onProgress,
    isCancelled: isCancelled,
  );
  ref.read(projectProvider.notifier).recordUploads(result.uploaded);
  return result.objectPaths;
}

/// Флаг v2 поднят, но адрес беты не задан: планирование недоступно, объясняем
/// пользователю понятно (§4C.7).
class _BetaUnavailableService implements AiEditingService {
  const _BetaUnavailableService();

  @override
  bool get isDemo => false;

  @override
  void cancel() {}

  @override
  Future<EditPlan> createEditPlan(
    EditRequest request, {
    ProcessingReporter? onProgress,
  }) async => throw const AiEditingException(
    'Бета недоступна: не задан адрес beta-сервиса. '
    'Обновите приложение или попробуйте позже.',
  );
}

final exportServiceProvider = Provider<VideoExportService>(
  (_) => const MockVideoExportService(),
);

final mediaPickerProvider = Provider<MediaPickerService>(
  (_) => MediaPickerService(),
);

/// Есть ли сохранённый черновик — для ссылки на старте.
final hasDraftProvider = FutureProvider<bool>(
  (ref) => ref.read(storageServiceProvider).hasDraft(),
);

final projectProvider = NotifierProvider<ProjectController, ProjectState>(
  ProjectController.new,
);

/// Контроллер состояния проекта. Инкапсулирует все правила и персистентность.
class ProjectController extends Notifier<ProjectState> {
  @override
  ProjectState build() => ProjectState.empty(const Uuid().v4());

  StorageService get _storage => ref.read(storageServiceProvider);

  void _emit(ProjectState next) {
    state = next;
    _persist();
  }

  Future<void> _persist() async {
    try {
      await _storage.saveDraft(state);
      ref.invalidate(hasDraftProvider);
    } catch (_) {
      // Персистентность best-effort: сбой сохранения не ломает сценарий.
    }
  }

  // --- Материалы -----------------------------------------------------------

  /// Добавляет проверенные материалы, применяя лимиты. Возвращает результат
  /// с принятыми и отклонёнными файлами.
  AddMediaResult addAssets(List<MediaAsset> candidates) {
    final result = MediaLimits.validateBatch(
      existing: state.assets,
      candidates: candidates,
    );
    if (result.hasAccepted) {
      _emit(state.copyWith(assets: [...state.assets, ...result.accepted]));
    }
    return result;
  }

  void removeAsset(String id) {
    final assets = state.assets.where((a) => a.id != id).toList();
    // Удалённый материал выпадает и из манифеста загрузки.
    _emit(
      state.copyWith(
        assets: assets,
        uploadManifest: state.uploadManifest.retainOnly({
          for (final a in assets) a.id,
        }),
      ),
    );
  }

  /// §4D.3: фиксирует вновь загруженные материалы в манифесте, чтобы analysis
  /// и render не грузили их повторно (переживает «Назад» и перезагрузку).
  void recordUploads(List<UploadedAsset> uploaded) {
    if (uploaded.isEmpty) return;
    _emit(
      state.copyWith(
        uploadManifest: state.uploadManifest.withUploaded(uploaded),
      ),
    );
  }

  /// [newIndex] уже скорректирован под удаление элемента (onReorderItem).
  void reorderAssets(int oldIndex, int newIndex) {
    final list = [...state.assets];
    final item = list.removeAt(oldIndex);
    list.insert(newIndex, item);
    _emit(state.copyWith(assets: list));
  }

  // --- Настройки -----------------------------------------------------------

  void setPrompt(String value) => _emit(state.copyWith(prompt: value));

  void setStyle(EditStyle style) => _emit(state.copyWith(style: style));

  void setDuration(int seconds) => _emit(
    state.copyWith(durationSeconds: MediaLimits.clampOutputSeconds(seconds)),
  );

  void setCaptionsEnabled(bool enabled) => _emit(
    state.copyWith(captions: state.captions.copyWith(enabled: enabled)),
  );

  void setCaptionLanguage(String language) => _emit(
    state.copyWith(captions: state.captions.copyWith(language: language)),
  );

  void setCaptionStyle(CaptionStyle style) =>
      _emit(state.copyWith(captions: state.captions.copyWith(style: style)));

  void setCaptionColor(String colorHex) => _emit(
    state.copyWith(captions: state.captions.copyWith(colorHex: colorHex)),
  );

  void setCaptionText(String text) => _emit(
    state.copyWith(captions: state.captions.copyWith(sampleText: text)),
  );

  /// Единственный звуковой переключатель (контракт v2 §1): сохранять ли
  /// оригинальный звук исходников. Обновляет и настройки проекта, и план,
  /// если он уже собран, — чтобы правка в редакторе доходила до рендера.
  void setKeepOriginalSound(bool keepOriginal) {
    final audio = AudioSettings(keepOriginal: keepOriginal);
    _emit(
      state.copyWith(
        audio: audio,
        plan: state.plan?.copyWith(audio: audio),
      ),
    );
  }

  // --- Этапы и план --------------------------------------------------------

  void setStage(AppStage stage) => _emit(state.copyWith(stage: stage));

  void setPlan(EditPlan plan) => _emit(
    state.copyWith(
      plan: plan,
      captions: plan.captions,
      audio: plan.audio,
      coverAssetId: plan.coverClipId,
    ),
  );

  // --- Правки плана --------------------------------------------------------

  void reorderClips(int oldIndex, int newIndex) {
    final plan = state.plan;
    if (plan == null) return;
    final list = [...plan.clips];
    final item = list.removeAt(oldIndex);
    list.insert(newIndex, item);
    _emit(state.copyWith(plan: plan.copyWith(clips: list)));
  }

  /// Удаляет клип и возвращает его вместе с позицией для отмены.
  ({EditClip clip, int index})? removeClipAt(int index) {
    final plan = state.plan;
    if (plan == null || index < 0 || index >= plan.clips.length) return null;
    final list = [...plan.clips];
    final removed = list.removeAt(index);
    _emit(state.copyWith(plan: plan.copyWith(clips: list)));
    return (clip: removed, index: index);
  }

  void restoreClip(EditClip clip, int index) {
    final plan = state.plan;
    if (plan == null) return;
    final list = [...plan.clips];
    final at = index.clamp(0, list.length);
    list.insert(at, clip);
    _emit(state.copyWith(plan: plan.copyWith(clips: list)));
  }

  /// Меняет ТИП перехода конкретного клипа, СОХРАНЯЯ его длительность и
  /// интенсивность (объект перехода v2 §2.1 не сводится к строке).
  void setClipTransition(int index, TransitionType type) {
    final plan = state.plan;
    if (plan == null || index < 0 || index >= plan.clips.length) return;
    final list = [...plan.clips];
    list[index] = list[index].copyWith(
      transition: list[index].transition.copyWith(type: type),
    );
    _emit(state.copyWith(plan: plan.copyWith(clips: list)));
  }

  // --- Текстовые слои (§4) -------------------------------------------------

  /// Потолок числа слоёв из контракта §4.
  static const int maxTextOverlays = 20;

  /// Добавляет слой, если не превышен потолок. Возвращает `false`, если
  /// слоёв уже 20.
  bool addTextOverlay(TextOverlay overlay) {
    final plan = state.plan;
    if (plan == null || plan.textOverlays.length >= maxTextOverlays) {
      return false;
    }
    _emit(
      state.copyWith(
        plan: plan.copyWith(textOverlays: [...plan.textOverlays, overlay]),
      ),
    );
    return true;
  }

  /// Заменяет слой с тем же id (правки из листа редактирования).
  void updateTextOverlay(TextOverlay overlay) {
    final plan = state.plan;
    if (plan == null) return;
    final list = [
      for (final o in plan.textOverlays)
        if (o.id == overlay.id) overlay else o,
    ];
    _emit(state.copyWith(plan: plan.copyWith(textOverlays: list)));
  }

  void removeTextOverlay(String id) {
    final plan = state.plan;
    if (plan == null) return;
    _emit(
      state.copyWith(
        plan: plan.copyWith(
          textOverlays: plan.textOverlays.where((o) => o.id != id).toList(),
        ),
      ),
    );
  }

  /// Перетаскивание: новый центр слоя в долях кадра (0..1 зажимается в
  /// copyWith). Безопасную зону не форсируем — только предупреждаем в UI.
  void repositionTextOverlay(String id, double x, double y) {
    final plan = state.plan;
    if (plan == null) return;
    final list = [
      for (final o in plan.textOverlays)
        if (o.id == id) o.copyWith(x: x, y: y) else o,
    ];
    _emit(state.copyWith(plan: plan.copyWith(textOverlays: list)));
  }

  void setPlanCaptions(CaptionSettings captions) {
    final plan = state.plan;
    _emit(
      state.copyWith(
        captions: captions,
        plan: plan?.copyWith(captions: captions),
      ),
    );
  }

  void setCover(String clipId) {
    final plan = state.plan;
    if (plan == null) return;
    _emit(
      state.copyWith(
        plan: plan.copyWith(coverClipId: clipId),
        coverAssetId: clipId,
      ),
    );
  }

  void setPlanExport(ExportSettings export) {
    final plan = state.plan;
    if (plan == null) return;
    _emit(state.copyWith(plan: plan.copyWith(export: export)));
  }

  // --- Черновик ------------------------------------------------------------

  Future<void> loadDraft() async {
    final draft = await _storage.loadDraft();
    if (draft != null) state = draft;
  }

  Future<void> clearProject() async {
    state = ProjectState.empty(const Uuid().v4());
    try {
      await _storage.clearDraft();
      ref.invalidate(hasDraftProvider);
    } catch (_) {
      // Игнорируем сбой очистки хранилища.
    }
  }
}
