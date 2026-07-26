import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import '../core/constants.dart';
import '../models/project_state.dart';

/// Локальное хранение черновика проекта.
///
/// Хранит только метаданные и пути к материалам, но никогда не загружает
/// пользовательские файлы в сеть.
class StorageService {
  const StorageService();

  Future<void> saveDraft(ProjectState state) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(
      AppConstants.draftStorageKey,
      jsonEncode(state.toJson()),
    );
  }

  Future<ProjectState?> loadDraft() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(AppConstants.draftStorageKey);
    if (raw == null || raw.isEmpty) return null;
    try {
      final json = jsonDecode(raw) as Map<String, dynamic>;
      return ProjectState.fromJson(json);
    } catch (_) {
      // Повреждённый черновик не должен блокировать запуск приложения.
      await clearDraft();
      return null;
    }
  }

  Future<bool> hasDraft() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(AppConstants.draftStorageKey);
    return raw != null && raw.isNotEmpty;
  }

  Future<void> clearDraft() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(AppConstants.draftStorageKey);
  }

  // --- Активная задача рендера ---------------------------------------------

  /// Запоминает задачу рендера, чтобы вернуться к ней после перезагрузки
  /// страницы или перезапуска приложения. Хранится только пара
  /// «проект → задача», без ссылок и токенов.
  Future<void> saveActiveRenderJob({
    required String projectId,
    required String jobId,
  }) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(
      AppConstants.activeRenderJobKey,
      jsonEncode({'projectId': projectId, 'jobId': jobId}),
    );
  }

  /// Возвращает сохранённую задачу рендера для проекта [projectId].
  ///
  /// `null`, если задачи нет или она относится к другому проекту.
  Future<String?> loadActiveRenderJob(String projectId) async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(AppConstants.activeRenderJobKey);
    if (raw == null || raw.isEmpty) return null;
    try {
      final json = jsonDecode(raw) as Map<String, dynamic>;
      if (json['projectId'] != projectId) return null;
      final jobId = json['jobId'];
      return jobId is String && jobId.isNotEmpty ? jobId : null;
    } catch (_) {
      await clearActiveRenderJob();
      return null;
    }
  }

  Future<void> clearActiveRenderJob() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(AppConstants.activeRenderJobKey);
  }
}
