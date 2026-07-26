import 'package:flutter_test/flutter_test.dart';
import 'package:reelio_ai/models/enums.dart';
import 'package:reelio_ai/models/media_asset.dart';
import 'package:reelio_ai/models/project_state.dart';
import 'package:reelio_ai/services/storage_service.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const storage = StorageService();

  ProjectState sampleProject() => ProjectState.empty('proj-1').copyWith(
    prompt: 'Ролик про море',
    style: EditStyle.cinematic,
    durationSeconds: 60,
    stage: AppStage.settings,
    assets: [
      MediaAsset(
        id: 'v1',
        path: '/tmp/v1.mp4',
        name: 'v1.mp4',
        type: MediaType.video,
        durationSeconds: 22,
      ),
      const MediaAsset(
        id: 'p1',
        path: '/tmp/p1.jpg',
        name: 'p1.jpg',
        type: MediaType.photo,
      ),
    ],
  );

  setUp(() => SharedPreferences.setMockInitialValues({}));

  test('сохранение и восстановление черновика', () async {
    expect(await storage.hasDraft(), isFalse);

    final project = sampleProject();
    await storage.saveDraft(project);

    expect(await storage.hasDraft(), isTrue);

    final restored = await storage.loadDraft();
    expect(restored, isNotNull);
    expect(restored!.id, project.id);
    expect(restored.prompt, 'Ролик про море');
    expect(restored.style, EditStyle.cinematic);
    expect(restored.durationSeconds, 60);
    expect(restored.stage, AppStage.settings);
    expect(restored.assets, hasLength(2));
    expect(restored.videoCount, 1);
    expect(restored.photoCount, 1);
    expect(restored.assets.first.durationSeconds, 22);
  });

  test('полное удаление черновика', () async {
    await storage.saveDraft(sampleProject());
    expect(await storage.hasDraft(), isTrue);

    await storage.clearDraft();
    expect(await storage.hasDraft(), isFalse);
    expect(await storage.loadDraft(), isNull);
  });

  test('JSON проекта восстанавливается без потерь', () {
    final project = sampleProject();
    final restored = ProjectState.fromJson(project.toJson());
    expect(restored.id, project.id);
    expect(restored.assets.length, project.assets.length);
    expect(restored.style, project.style);
    expect(restored.durationSeconds, project.durationSeconds);
  });
}
