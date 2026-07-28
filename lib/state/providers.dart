import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';

import '../core/app_config.dart';
import '../core/media_validation.dart';
import '../models/edit_plan.dart';
import '../models/enums.dart';
import '../models/export_settings.dart';
import '../models/media_asset.dart';
import '../models/project_state.dart';
import '../models/transition.dart';
import '../services/ai_editing_service.dart';
import 'auth_providers.dart';
import '../services/gemini_ai_editing_service.dart';
import '../services/media_picker_service.dart';
import '../services/storage_service.dart';
import '../services/video_export_service.dart';

final uuidProvider = Provider<Uuid>((_) => const Uuid());

final storageServiceProvider = Provider<StorageService>(
  (_) => const StorageService(),
);

/// Выбирает реальный Gemini-планировщик, если задан backend
/// (`--dart-define=REELIO_BACKEND_URL=…`), иначе — мок (Demo Mode).
final aiServiceProvider = Provider<AiEditingService>((ref) {
  if (AppConfig.hasBackend) {
    // /edit-plan защищён так же, как остальной API: без токенов он ответит
    // 401, и до Gemini запрос не дойдёт.
    final service = GeminiAiEditingService(
      tokens: ref.watch(authTokensProvider),
    );
    ref.onDispose(service.cancel);
    return service;
  }
  return const MockAiEditingService();
});

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
    _emit(
      state.copyWith(assets: state.assets.where((a) => a.id != id).toList()),
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

  /// Меняет переход конкретного клипа. Хранится строкой каталога v2 (§2.1);
  /// длительность и интенсивность worker берёт по умолчанию.
  void setClipTransition(int index, TransitionType type) {
    final plan = state.plan;
    if (plan == null || index < 0 || index >= plan.clips.length) return;
    final list = [...plan.clips];
    list[index] = list[index].copyWith(transition: type.storageValue);
    _emit(state.copyWith(plan: plan.copyWith(clips: list)));
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
