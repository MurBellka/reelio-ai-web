import 'edit_plan.dart';
import 'enums.dart';
import 'media_asset.dart';

/// Запрос на построение монтажного плана.
///
/// Это единственный вход [AiEditingService]. UI формирует его из состояния
/// проекта, поэтому позднее его легко сериализовать и отправить на сервер.
class EditRequest {
  const EditRequest({
    required this.assets,
    required this.prompt,
    required this.style,
    required this.durationSeconds,
    required this.captions,
    required this.music,
  });

  final List<MediaAsset> assets;
  final String prompt;
  final EditStyle style;
  final int durationSeconds;
  final CaptionSettings captions;
  final MusicSettings music;

  Map<String, dynamic> toJson() => {
    'prompt': prompt,
    'style': style.storageValue,
    'durationSeconds': durationSeconds,
    'captions': captions.toJson(),
    'music': music.toJson(),
    'assets': assets.map((a) => a.toJson()).toList(),
  };
}

/// Результат экспорта монтажного плана.
class ExportResult {
  const ExportResult({
    required this.planFilePath,
    required this.planJson,
    required this.estimatedSizeBytes,
    required this.durationSeconds,
    required this.isDemo,
  });

  /// Путь к сохранённому JSON монтажного плана (пусто на web).
  final String planFilePath;

  /// Сериализованный монтажный план — источник для шаринга/скачивания на web.
  final String planJson;

  /// Демонстрационная оценка размера итогового файла.
  final int estimatedSizeBytes;

  final int durationSeconds;

  /// Является ли экспорт демонстрационным (без настоящего рендера).
  final bool isDemo;
}
