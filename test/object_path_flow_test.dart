// Пути объектов на всём пути от выбора материалов до /render.
//
// Инцидент: клиент строил путь по схеме на поколение раньше — без сегмента
// users/{uid}/ — и backend отвергал загрузку с INVALID_OBJECT_PATH. Отдельно
// проверяется, что projectId один на весь поток и что путь берётся из ответа
// сервера, а не сочиняется клиентом.

import 'package:flutter_test/flutter_test.dart';
import 'package:reelio_ai/models/edit_plan.dart';
import 'package:reelio_ai/models/enums.dart';
import 'package:reelio_ai/models/media_asset.dart';
import 'package:reelio_ai/models/project_state.dart';
import 'package:reelio_ai/models/render_request.dart';

const _uid = 'user1';
const _project = 'proj_abc';

MediaAsset _asset(
  String id, {
  String name = 'a.mp4',
  MediaType type = MediaType.video,
}) => MediaAsset(
  id: id,
  path: '/local/$name',
  name: name,
  type: type,
  durationSeconds: type == MediaType.video ? 12 : null,
  width: 1080,
  height: 1920,
);

EditPlan _plan(List<MediaAsset> assets) => EditPlan(
  id: 'plan_1',
  prompt: 'тест',
  style: EditStyle.dynamicStyle,
  durationSeconds: 8,
  captions: CaptionSettings.defaults,
  audio: AudioSettings.defaults,
  clips: [
    for (final a in assets)
      EditClip(
        id: 'clip_${a.id}',
        filePath: a.path,
        type: a.type,
        duration: 4,
        transition: 'cut',
        mediaId: a.id,
        start: a.type == MediaType.video ? 0 : null,
        end: a.type == MediaType.video ? 4 : null,
        sourceName: a.name,
      ),
  ],
);

ProjectState _projectWith(List<MediaAsset> assets) =>
    ProjectState.empty(_project).copyWith(assets: assets, plan: _plan(assets));

/// Пути, как их выдаёт backend.
Map<String, String> _issued(List<MediaAsset> assets) => {
  for (final a in assets)
    a.id: 'users/$_uid/projects/$_project/sources/${a.id}.mp4',
};

void main() {
  group('предлагаемый путь для /uploads', () {
    test('содержит uid владельца — иначе backend отклонит', () {
      final path = RenderAsset.proposedSourcePath(
        ownerUid: _uid,
        projectId: _project,
        asset: _asset('asset_a'),
      );
      expect(path, startsWith('users/$_uid/projects/$_project/sources/'));
      // Ровно тот дефект, который отвергался в production.
      expect(path, isNot(startsWith('projects/')));
    });

    test('имя файла берётся из id, а не из названия материала', () {
      // Кириллица и пробелы в пользовательском имени не должны попадать в путь.
      final path = RenderAsset.proposedSourcePath(
        ownerUid: _uid,
        projectId: _project,
        asset: _asset('asset_a', name: 'Мой ролик с моря 2.mp4'),
      );
      expect(path, endsWith('/asset_a.mp4'));
      expect(path, matches(RegExp(r'^[A-Za-z0-9._/-]+$')));
    });

    test('два файла с одинаковым названием дают разные пути', () {
      final first = RenderAsset.proposedSourcePath(
        ownerUid: _uid,
        projectId: _project,
        asset: _asset('asset_a', name: 'video.mp4'),
      );
      final second = RenderAsset.proposedSourcePath(
        ownerUid: _uid,
        projectId: _project,
        asset: _asset('asset_b', name: 'video.mp4'),
      );
      expect(first, isNot(second));
    });

    test('расширение подставляется по типу, если его нет в имени', () {
      final photo = RenderAsset.proposedSourcePath(
        ownerUid: _uid,
        projectId: _project,
        asset: _asset('asset_p', name: 'снимок', type: MediaType.photo),
      );
      expect(photo, endsWith('/asset_p.jpg'));
    });
  });

  group('сборка /render', () {
    test('берёт путь из ответа сервера, а не строит сама', () {
      final assets = [_asset('asset_a')];
      // Сервер вернул путь, отличающийся от предполагаемого клиентом.
      const serverPath = 'users/$_uid/projects/$_project/sources/asset_a.mov';

      final request = RenderRequest.fromProject(
        _projectWith(assets),
        objectPathsByAssetId: const {'asset_a': serverPath},
      );

      expect(request.assets.single.objectPath, serverPath);
    });

    test('локальный путь и blob-URL в objectPath не попадают', () {
      final assets = [_asset('asset_a', name: 'a.mp4')];
      final request = RenderRequest.fromProject(
        _projectWith(assets),
        objectPathsByAssetId: _issued(assets),
      );

      final path = request.assets.single.objectPath;
      expect(path, isNot(contains('blob:')));
      expect(path, isNot(contains('/local/')));
      expect(path, startsWith('users/'));
    });

    test('материалы сопоставляются по mediaId, а не по имени файла', () {
      // Оба материала называются одинаково — различить их можно только по id.
      final assets = [
        _asset('asset_a', name: 'video.mp4'),
        _asset('asset_b', name: 'video.mp4'),
      ];
      final request = RenderRequest.fromProject(
        _projectWith(assets),
        objectPathsByAssetId: _issued(assets),
      );

      expect(request.assets.map((a) => a.id), ['asset_a', 'asset_b']);
      expect(
        request.assets.map((a) => a.objectPath).toSet().length,
        2,
        reason: 'у одинаково названных файлов должны быть разные объекты',
      );
    });

    test('без выданного пути просит загрузить материалы заново', () {
      // Так выглядит проект, созданный до смены схемы хранения.
      final assets = [_asset('asset_a', name: 'старое видео.mp4')];
      expect(
        () => RenderRequest.fromProject(
          _projectWith(assets),
          objectPathsByAssetId: const {},
        ),
        throwsA(
          isA<RenderRequestException>().having(
            (e) => e.message,
            'message',
            allOf(contains('загрузить заново'), contains('старое видео.mp4')),
          ),
        ),
      );
    });

    test('projectId в запросе совпадает с проектом', () {
      final assets = [_asset('asset_a')];
      final request = RenderRequest.fromProject(
        _projectWith(assets),
        objectPathsByAssetId: _issued(assets),
      );
      expect(request.projectId, _project);
      // И путь построен вокруг того же идентификатора.
      expect(
        request.assets.single.objectPath,
        contains('/projects/$_project/'),
      );
    });
  });

  group('устойчивость projectId', () {
    test('один и тот же id проходит через все этапы', () {
      final assets = [_asset('asset_a')];
      final project = _projectWith(assets);

      final proposed = RenderAsset.proposedSourcePath(
        ownerUid: _uid,
        projectId: project.id,
        asset: assets.single,
      );
      final request = RenderRequest.fromProject(
        project,
        objectPathsByAssetId: {'asset_a': proposed},
      );

      // uploads → render: один идентификатор, один каталог.
      expect(proposed, contains('/projects/${project.id}/'));
      expect(request.projectId, project.id);
      expect(
        request.assets.single.objectPath,
        contains('/projects/${project.id}/'),
      );
    });

    test('повторная сборка запроса не меняет ни id, ни пути', () {
      // Повторный рендер и возврат на экран экспорта не должны ничего менять.
      final assets = [_asset('asset_a')];
      final project = _projectWith(assets);
      final paths = _issued(assets);

      final first = RenderRequest.fromProject(
        project,
        objectPathsByAssetId: paths,
      );
      final second = RenderRequest.fromProject(
        project,
        objectPathsByAssetId: paths,
      );

      expect(first.projectId, second.projectId);
      expect(first.assets.single.objectPath, second.assets.single.objectPath);
    });

    test('id переживает сохранение и восстановление черновика', () {
      // Перезагрузка страницы: состояние поднимается из хранилища.
      final assets = [_asset('asset_a')];
      final project = _projectWith(assets);

      final restored = ProjectState.fromJson(project.toJson());

      expect(restored.id, project.id);
      final request = RenderRequest.fromProject(
        restored,
        objectPathsByAssetId: _issued(assets),
      );
      expect(request.projectId, project.id);
    });
  });

  group('чужие каталоги', () {
    test('путь другого пользователя виден как чужой', () {
      // Клиент такой путь не построит, но проверка обязана оставаться на месте:
      // окончательное решение принимает backend.
      final mine = RenderAsset.proposedSourcePath(
        ownerUid: _uid,
        projectId: _project,
        asset: _asset('asset_a'),
      );
      const foreign =
          'users/someone_else/projects/$_project/sources/asset_a.mp4';

      expect(mine.startsWith('users/$_uid/'), isTrue);
      expect(foreign.startsWith('users/$_uid/'), isFalse);
    });

    test('путь чужого проекта того же пользователя тоже не совпадает', () {
      final mine = RenderAsset.proposedSourcePath(
        ownerUid: _uid,
        projectId: _project,
        asset: _asset('asset_a'),
      );
      expect(mine.startsWith('users/$_uid/projects/$_project/'), isTrue);
      expect(mine.startsWith('users/$_uid/projects/other_project/'), isFalse);
    });
  });
}
