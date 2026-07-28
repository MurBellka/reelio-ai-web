import 'package:uuid/uuid.dart';

import '../core/media_validation.dart';
import '../models/edit_plan.dart';
import '../models/edit_request.dart';
import '../models/enums.dart';
import '../models/export_settings.dart';
import '../models/media_asset.dart';
import 'ai_editing_service.dart';

/// Разрешённые типы переходов (allowlist).
const _allowedTransitions = {'cut', 'fade', 'crossfade', 'slide'};

EditStyle _styleFrom(String? v) => switch (v) {
  'dynamic' || 'dynamicStyle' => EditStyle.dynamicStyle,
  'cinematic' => EditStyle.cinematic,
  'calm' => EditStyle.calm,
  'minimal' => EditStyle.minimal,
  _ => EditStyle.dynamicStyle,
};

CaptionStyle _captionStyleFrom(String? v) => switch (v) {
  'clean' => CaptionStyle.clean,
  'bold' => CaptionStyle.bold,
  'karaoke' => CaptionStyle.karaoke,
  _ => CaptionStyle.bold,
};

/// Преобразует и валидирует строго типизированный JSON-ответ Gemini
/// (через backend) в [EditPlan]. Бросает [AiEditingException] на любой
/// некорректный или повреждённый ответ.
///
/// Чистая функция без сети — удобно для юнит-тестов.
EditPlan parseGeminiPlan(
  Object? raw, {
  required EditRequest request,
  Uuid uuid = const Uuid(),
}) {
  if (raw is! Map) {
    throw const AiEditingException('Сервер вернул некорректный ответ.');
  }
  final json = raw.cast<String, dynamic>();

  final clipsRaw = json['clips'];
  if (clipsRaw is! List || clipsRaw.isEmpty) {
    throw const AiEditingException(
      'Сервер вернул план без клипов. Попробуйте ещё раз.',
    );
  }

  final assetsById = {for (final a in request.assets) a.id: a};

  final target = MediaLimits.clampOutputSeconds(
    (json['durationSeconds'] as num?)?.round() ?? request.durationSeconds,
  );

  final clips = <EditClip>[];
  var used = 0.0;
  for (final item in clipsRaw) {
    if (item is! Map) {
      throw const AiEditingException('Некорректный клип в ответе сервера.');
    }
    final c = item.cast<String, dynamic>();
    final mediaId = c['mediaId'];
    if (mediaId is! String || !assetsById.containsKey(mediaId)) {
      throw const AiEditingException(
        'Сервер сослался на неизвестный материал.',
      );
    }
    final asset = assetsById[mediaId]!;
    final start = (c['start'] as num?)?.toDouble() ?? 0;
    final end = (c['end'] as num?)?.toDouble();
    if (end == null || end <= start || start < 0) {
      throw const AiEditingException(
        'Некорректные тайминги клипа в ответе сервера.',
      );
    }
    var duration = end - start;
    final remaining = target - used;
    if (remaining <= 0.4) break;
    if (duration > remaining) duration = remaining;
    if (duration < 0.4) continue;

    final transition = (c['transition'] as String?) ?? 'cut';
    clips.add(
      EditClip(
        id: uuid.v4(),
        filePath: asset.path,
        type: asset.type,
        duration: double.parse(duration.toStringAsFixed(2)),
        start: asset.isVideo ? start : null,
        end: asset.isVideo ? start + duration : null,
        transition: _allowedTransitions.contains(transition)
            ? transition
            : 'cut',
        sourceName: asset.name,
        mediaId: mediaId,
        reason: (c['reason'] as String?) ?? '',
      ),
    );
    used += duration;
  }

  if (clips.isEmpty) {
    throw const AiEditingException(
      'Не удалось собрать план из ответа сервера.',
    );
  }

  final captionsJson = (json['captions'] as Map?)?.cast<String, dynamic>();
  final captions = CaptionSettings(
    enabled: captionsJson?['enabled'] as bool? ?? request.captions.enabled,
    language: captionsJson?['language'] as String? ?? request.captions.language,
    style: _captionStyleFrom(captionsJson?['style'] as String?),
    colorHex: request.captions.colorHex,
    sampleText: request.captions.sampleText,
  );

  // Музыка убрана из контракта v2 (§0). Если сервер прислал звук, читаем
  // единственный переключатель; иначе оставляем выбор пользователя.
  final audioJson = (json['audio'] as Map?)?.cast<String, dynamic>();
  final audio = AudioSettings(
    keepOriginal:
        audioJson?['keepOriginal'] as bool? ?? request.audio.keepOriginal,
  );

  final export = ExportResolver.build(
    choice: ExportResolution.maximumAvailable,
    durationSeconds: target,
    sourceMaxHeight: _sourceMaxHeight(request.assets),
  );

  return EditPlan(
    id: uuid.v4(),
    prompt: request.prompt,
    style: _styleFrom(json['style'] as String?),
    durationSeconds: target,
    captions: captions,
    audio: audio,
    clips: clips,
    coverClipId: clips.first.id,
    export: export,
  );
}

int? _sourceMaxHeight(List<MediaAsset> assets) {
  int? best;
  for (final a in assets) {
    final s = a.maxSide;
    if (s != null && (best == null || s > best)) best = s;
  }
  return best;
}
