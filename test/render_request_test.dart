import 'package:flutter_test/flutter_test.dart';
import 'package:reelio_ai/models/edit_plan.dart';
import 'package:reelio_ai/models/transition.dart';
import 'package:reelio_ai/models/enums.dart';
import 'package:reelio_ai/models/export_settings.dart';
import 'package:reelio_ai/models/media_asset.dart';
import 'package:reelio_ai/models/project_state.dart';
import 'package:reelio_ai/models/render_request.dart';

const videoAsset = MediaAsset(
  id: 'asset_a',
  path: '/local/IMG_0042.MP4',
  name: 'IMG_0042.MP4',
  type: MediaType.video,
  durationSeconds: 41.2,
  width: 1080,
  height: 1920,
);

const photoAsset = MediaAsset(
  id: 'asset_b',
  path: '/local/photo.heic',
  name: 'photo.heic',
  type: MediaType.photo,
  width: 3024,
  height: 4032,
);

EditPlan planWith(List<EditClip> clips, {ExportSettings? export}) => EditPlan(
  id: 'plan_7f3c',
  prompt: 'динамичный ролик о поездке',
  style: EditStyle.dynamicStyle,
  durationSeconds: 30,
  captions: CaptionSettings.defaults,
  audio: AudioSettings.defaults,
  clips: clips,
  coverClipId: clips.isEmpty ? null : clips.first.id,
  export: export ?? ExportSettings.defaults,
);

ProjectState projectWith(EditPlan? plan, {List<MediaAsset>? assets}) =>
    ProjectState.empty(
      'proj_9d1',
    ).copyWith(assets: assets ?? const [videoAsset, photoAsset], plan: plan);

void main() {
  group('Пути объектов', () {
    test('исходники лежат под users/{uid}/projects/{projectId}/sources/', () {
      final path = RenderAsset.proposedSourcePath(
        ownerUid: 'u1',
        projectId: 'proj_9d1',
        asset: videoAsset,
      );
      expect(path, 'users/u1/projects/proj_9d1/sources/asset_a.mp4');
    });

    test('расширение берётся из имени и приводится к нижнему регистру', () {
      final path = RenderAsset.proposedSourcePath(
        ownerUid: 'u1',
        projectId: 'proj_9d1',
        asset: photoAsset,
      );
      expect(path, 'users/u1/projects/proj_9d1/sources/asset_b.heic');
    });

    test('без расширения путь остаётся валидным', () {
      const noExt = MediaAsset(
        id: 'asset_c',
        path: '/local/clip',
        name: 'clip',
        type: MediaType.video,
      );
      expect(
        RenderAsset.proposedSourcePath(
          ownerUid: 'u1',
          projectId: 'p1',
          asset: noExt,
        ),
        'users/u1/projects/p1/sources/asset_c.mp4',
      );
    });
  });

  group('Сборка RenderRequest', () {
    test('запрос соответствует контракту v1', () {
      final plan = planWith([
        const EditClip(
          id: 'clip_1',
          filePath: '/local/IMG_0042.MP4',
          type: MediaType.video,
          duration: 3.5,
          start: 12,
          end: 15.5,
          transition: TransitionSpec(type: TransitionType.dissolve),
          mediaId: 'asset_a',
          sourceName: 'IMG_0042.MP4',
        ),
      ]);

      final request = RenderRequest.fromProject(
        objectPathsByAssetId: const {
          'asset_a': 'users/u1/projects/proj_9d1/sources/asset_a.mp4',
          'asset_b': 'users/u1/projects/proj_9d1/sources/asset_b.heic',
        },
        projectWith(plan),
      );
      final json = request.toJson();

      expect(json['contractVersion'], 1);
      expect(json['projectId'], 'proj_9d1');
      expect((json['plan'] as Map)['id'], 'plan_7f3c');

      final assets = json['assets'] as List;
      expect(assets, hasLength(1)); // отправляем только используемые материалы
      final asset = assets.single as Map;
      expect(asset['id'], 'asset_a');
      expect(
        asset['objectPath'],
        'users/u1/projects/proj_9d1/sources/asset_a.mp4',
      );
      expect(asset['durationSeconds'], closeTo(41.2, 1e-9));
      expect(asset['width'], 1080);
    });

    test('каждый mediaId клипа присутствует в assets', () {
      final plan = planWith([
        const EditClip(
          id: 'clip_1',
          filePath: '/local/IMG_0042.MP4',
          type: MediaType.video,
          duration: 3,
          start: 0,
          end: 3,
          transition: TransitionSpec(type: TransitionType.cut),
          mediaId: 'asset_a',
        ),
        const EditClip(
          id: 'clip_2',
          filePath: '/local/photo.heic',
          type: MediaType.photo,
          duration: 2,
          transition: TransitionSpec(type: TransitionType.fadeBlack),
          mediaId: 'asset_b',
        ),
      ]);

      final request = RenderRequest.fromProject(
        objectPathsByAssetId: const {
          'asset_a': 'users/u1/projects/proj_9d1/sources/asset_a.mp4',
          'asset_b': 'users/u1/projects/proj_9d1/sources/asset_b.heic',
        },
        projectWith(plan),
      );
      final ids = request.assets.map((a) => a.id).toSet();

      for (final clip in request.plan.clips) {
        expect(ids, contains(clip.mediaId));
      }
      expect(request.assets, hasLength(2));
    });

    test('mediaId восстанавливается по локальному пути в старых планах', () {
      final plan = planWith([
        const EditClip(
          id: 'clip_1',
          filePath: '/local/IMG_0042.MP4',
          type: MediaType.video,
          duration: 3,
          start: 0,
          end: 3,
          transition: TransitionSpec(type: TransitionType.cut),
        ),
      ]);

      final request = RenderRequest.fromProject(
        objectPathsByAssetId: const {
          'asset_a': 'users/u1/projects/proj_9d1/sources/asset_a.mp4',
          'asset_b': 'users/u1/projects/proj_9d1/sources/asset_b.heic',
        },
        projectWith(plan),
      );
      expect(request.plan.clips.single.mediaId, 'asset_a');
    });

    test('размеры файлов попадают в запрос после загрузки', () {
      final plan = planWith([
        const EditClip(
          id: 'clip_1',
          filePath: '/local/IMG_0042.MP4',
          type: MediaType.video,
          duration: 3,
          start: 0,
          end: 3,
          transition: TransitionSpec(type: TransitionType.cut),
          mediaId: 'asset_a',
        ),
      ]);

      final request = RenderRequest.fromProject(
        objectPathsByAssetId: const {
          'asset_a': 'users/u1/projects/proj_9d1/sources/asset_a.mp4',
          'asset_b': 'users/u1/projects/proj_9d1/sources/asset_b.heic',
        },

        projectWith(plan),
        sizesByAssetId: const {'asset_a': 18234112},
      );
      expect(request.assets.single.sizeBytes, 18234112);
    });

    test('выбранное разрешение уходит в export запроса', () {
      final export = ExportResolver.build(
        choice: ExportResolution.twoK1440,
        durationSeconds: 30,
        sourceMaxHeight: 4032,
      );
      final plan = planWith([
        const EditClip(
          id: 'clip_1',
          filePath: '/local/IMG_0042.MP4',
          type: MediaType.video,
          duration: 3,
          start: 0,
          end: 3,
          transition: TransitionSpec(type: TransitionType.cut),
          mediaId: 'asset_a',
        ),
      ], export: export);

      final json = RenderRequest.fromProject(
        objectPathsByAssetId: const {
          'asset_a': 'users/u1/projects/proj_9d1/sources/asset_a.mp4',
          'asset_b': 'users/u1/projects/proj_9d1/sources/asset_b.heic',
        },
        projectWith(plan),
      ).toJson();
      expect((json['export'] as Map)['resolution'], 'twoK1440');
      expect((json['export'] as Map)['fps'], 30);
    });

    test('maximumAvailable передаётся серверу как есть', () {
      final plan = planWith([
        const EditClip(
          id: 'clip_1',
          filePath: '/local/IMG_0042.MP4',
          type: MediaType.video,
          duration: 3,
          start: 0,
          end: 3,
          transition: TransitionSpec(type: TransitionType.cut),
          mediaId: 'asset_a',
        ),
      ], export: ExportSettings.defaults);

      final json = RenderRequest.fromProject(
        objectPathsByAssetId: const {
          'asset_a': 'users/u1/projects/proj_9d1/sources/asset_a.mp4',
          'asset_b': 'users/u1/projects/proj_9d1/sources/asset_b.heic',
        },
        projectWith(plan),
      ).toJson();
      expect((json['export'] as Map)['resolution'], 'maximumAvailable');
    });
  });

  group('Проект не готов к рендеру', () {
    test('нет плана', () {
      expect(
        () => RenderRequest.fromProject(
          objectPathsByAssetId: const {
            'asset_a': 'users/u1/projects/proj_9d1/sources/asset_a.mp4',
            'asset_b': 'users/u1/projects/proj_9d1/sources/asset_b.heic',
          },
          projectWith(null),
        ),
        throwsA(isA<RenderRequestException>()),
      );
    });

    test('нет материалов', () {
      final plan = planWith([
        const EditClip(
          id: 'clip_1',
          filePath: '/local/IMG_0042.MP4',
          type: MediaType.video,
          duration: 3,
          transition: TransitionSpec(type: TransitionType.cut),
          mediaId: 'asset_a',
        ),
      ]);
      expect(
        () => RenderRequest.fromProject(
          objectPathsByAssetId: const {
            'asset_a': 'users/u1/projects/proj_9d1/sources/asset_a.mp4',
            'asset_b': 'users/u1/projects/proj_9d1/sources/asset_b.heic',
          },
          projectWith(plan, assets: const []),
        ),
        throwsA(isA<RenderRequestException>()),
      );
    });

    test('клип ссылается на удалённый материал', () {
      final plan = planWith([
        const EditClip(
          id: 'clip_1',
          filePath: '/local/gone.mp4',
          type: MediaType.video,
          duration: 3,
          transition: TransitionSpec(type: TransitionType.cut),
          mediaId: 'asset_missing',
        ),
      ]);
      expect(
        () => RenderRequest.fromProject(
          objectPathsByAssetId: const {
            'asset_a': 'users/u1/projects/proj_9d1/sources/asset_a.mp4',
            'asset_b': 'users/u1/projects/proj_9d1/sources/asset_b.heic',
          },
          projectWith(plan),
        ),
        throwsA(isA<RenderRequestException>()),
      );
    });
  });
}
