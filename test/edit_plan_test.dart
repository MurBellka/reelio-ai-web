import 'package:flutter_test/flutter_test.dart';
import 'package:reelio_ai/models/edit_plan.dart';
import 'package:reelio_ai/models/edit_request.dart';
import 'package:reelio_ai/models/enums.dart';
import 'package:reelio_ai/models/media_asset.dart';
import 'package:reelio_ai/services/ai_editing_service.dart';

EditRequest requestWith({
  required List<MediaAsset> assets,
  int duration = 30,
}) => EditRequest(
  assets: assets,
  prompt: 'Тестовый ролик',
  style: EditStyle.dynamicStyle,
  durationSeconds: duration,
  captions: CaptionSettings.defaults,
  music: MusicSettings.defaults,
);

List<MediaAsset> sampleAssets() => [
  MediaAsset(
    id: 'v1',
    path: '/tmp/v1.mp4',
    name: 'v1.mp4',
    type: MediaType.video,
    durationSeconds: 40,
  ),
  MediaAsset(
    id: 'v2',
    path: '/tmp/v2.mp4',
    name: 'v2.mp4',
    type: MediaType.video,
    durationSeconds: 12,
  ),
  const MediaAsset(
    id: 'p1',
    path: '/tmp/p1.jpg',
    name: 'p1.jpg',
    type: MediaType.photo,
  ),
];

void main() {
  const service = MockAiEditingService();

  test('создаёт монтажный план из материалов', () async {
    final plan = await service.createEditPlan(
      requestWith(assets: sampleAssets(), duration: 30),
    );
    expect(plan.clips, isNotEmpty);
    expect(plan.durationSeconds, 30);
    expect(plan.coverClipId, isNotNull);
    // Каждый клип ссылается на существующий путь ассета.
    final paths = sampleAssets().map((a) => a.path).toSet();
    for (final clip in plan.clips) {
      expect(paths.contains(clip.filePath), isTrue);
    }
  });

  test('итоговая длительность не превышает целевую', () async {
    final plan = await service.createEditPlan(
      requestWith(assets: sampleAssets(), duration: 15),
    );
    expect(plan.computedDuration, lessThanOrEqualTo(15.0 + 0.001));
  });

  test('запрос сверх лимита ограничивается 120 секундами', () async {
    final plan = await service.createEditPlan(
      requestWith(assets: sampleAssets(), duration: 999),
    );
    expect(plan.durationSeconds, 120);
    expect(plan.computedDuration, lessThanOrEqualTo(120.0 + 0.001));
  });

  test('первый переход — cut', () async {
    final plan = await service.createEditPlan(
      requestWith(assets: sampleAssets()),
    );
    expect(plan.clips.first.transition, 'cut');
  });

  test('план сериализуется и восстанавливается без потерь', () async {
    final plan = await service.createEditPlan(
      requestWith(assets: sampleAssets()),
    );
    final restored = EditPlan.fromJson(plan.toJson());
    expect(restored.clips.length, plan.clips.length);
    expect(restored.durationSeconds, plan.durationSeconds);
    expect(restored.style, plan.style);
    expect(restored.coverClipId, plan.coverClipId);
  });
}
