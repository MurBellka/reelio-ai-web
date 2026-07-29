// §4D.3: единая загрузка. Материал загружается один раз (по стабильному
// mediaId), analysis и render переиспользуют объект; повторно грузится только
// отсутствующий; удалённый выпадает из манифеста.

import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:reelio_ai/models/enums.dart';
import 'package:reelio_ai/models/media_asset.dart';
import 'package:reelio_ai/models/project_state.dart';
import 'package:reelio_ai/models/upload_manifest.dart';
import 'package:reelio_ai/services/media_upload_service.dart';
import 'package:reelio_ai/services/render_api_client.dart';
import 'package:reelio_ai/services/upload_coordinator.dart';

MediaAsset _asset(String id) => MediaAsset(
  id: id,
  path: '/local/$id.mp4',
  name: '$id.mp4',
  type: MediaType.video,
  durationSeconds: 5,
);

/// Render API, отдающий по тикету на каждый ЗАПРОШЕННЫЙ материал. Считает,
/// сколько материалов реально пошло на загрузку.
({RenderApiClient api, List<List<String>> requested}) fakeUploadsApi() {
  final requested = <List<String>>[];
  final api = RenderApiClient(
    baseUrl: 'https://beta.example',
    client: MockClient((req) async {
      final body = jsonDecode(req.body) as Map<String, dynamic>;
      final assets = (body['assets'] as List).cast<Map<String, dynamic>>();
      requested.add([for (final a in assets) a['id'] as String]);
      return http.Response(
        jsonEncode({
          'uploads': [
            for (final a in assets)
              {
                'assetId': a['id'],
                'objectPath': 'users/u/projects/p1/sources/${a['id']}.mp4',
                'uploadUrl': 'https://storage.example/put/${a['id']}',
                'method': 'PUT',
              },
          ],
        }),
        200,
        headers: {'content-type': 'application/json'},
      );
    }),
  );
  return (api: api, requested: requested);
}

MediaUploadService fakeUploader() => MediaUploadService(
  client: MockClient((_) async => http.Response('', 200)),
  readBytes: (_) async => Uint8List.fromList(List.filled(16, 7)),
);

void main() {
  group('UploadManifest', () {
    test('withUploaded/retainOnly/objectPaths/JSON', () {
      final m = UploadManifest.empty.withUploaded([
        UploadedAsset(
          mediaId: 'a1',
          objectPath: 'p/a1',
          sizeBytes: 10,
          uploadedAt: DateTime(2026),
        ),
        UploadedAsset(
          mediaId: 'a2',
          objectPath: 'p/a2',
          sizeBytes: 20,
          uploadedAt: DateTime(2026),
        ),
      ]);
      expect(m.objectPaths, {'a1': 'p/a1', 'a2': 'p/a2'});
      expect(m.retainOnly({'a2'}).contains('a1'), isFalse);
      final r = UploadManifest.fromJson(m.toJson());
      expect(r.forMedia('a1')!.objectPath, 'p/a1');
      expect(r.forMedia('a2')!.sizeBytes, 20);
    });

    test('ProjectState несёт манифест через круговой рейс', () {
      final p = ProjectState.empty('proj-1').copyWith(
        uploadManifest: UploadManifest.empty.withUploaded([
          UploadedAsset(
            mediaId: 'a1',
            objectPath: 'p/a1',
            sizeBytes: 1,
            uploadedAt: DateTime(2026),
          ),
        ]),
      );
      final r = ProjectState.fromJson(p.toJson());
      expect(r.uploadManifest.forMedia('a1')!.objectPath, 'p/a1');
    });
  });

  group('UploadCoordinator.ensureUploaded', () {
    test('пустой манифест — грузит все материалы', () async {
      final up = fakeUploadsApi();
      final coordinator = UploadCoordinator(
        api: up.api,
        uploader: fakeUploader(),
      );
      final res = await coordinator.ensureUploaded(
        assets: [_asset('a1'), _asset('a2')],
        manifest: UploadManifest.empty,
        ownerUid: 'u',
        projectId: 'p1',
      );
      expect(res.objectPaths.keys.toSet(), {'a1', 'a2'});
      expect(res.uploaded, hasLength(2));
      expect(up.requested.single.toSet(), {'a1', 'a2'});
    });

    test(
      'уже загруженный переиспользуется — грузится только отсутствующий',
      () async {
        final up = fakeUploadsApi();
        final coordinator = UploadCoordinator(
          api: up.api,
          uploader: fakeUploader(),
        );
        final manifest = UploadManifest.empty.withUploaded([
          UploadedAsset(
            mediaId: 'a1',
            objectPath: 'users/u/projects/p1/sources/a1.mp4',
            sizeBytes: 99,
            uploadedAt: DateTime(2026),
          ),
        ]);
        final res = await coordinator.ensureUploaded(
          assets: [_asset('a1'), _asset('a2')],
          manifest: manifest,
          ownerUid: 'u',
          projectId: 'p1',
        );
        // На загрузку пошёл ТОЛЬКО a2.
        expect(up.requested.single, ['a2']);
        expect(res.uploaded.map((u) => u.mediaId), ['a2']);
        // Путь a1 взят из манифеста без загрузки.
        expect(res.objectPaths['a1'], 'users/u/projects/p1/sources/a1.mp4');
        expect(res.objectPaths['a2'], 'users/u/projects/p1/sources/a2.mp4');
      },
    );

    test('все загружены — повторной загрузки нет вовсе', () async {
      final up = fakeUploadsApi();
      final coordinator = UploadCoordinator(
        api: up.api,
        uploader: fakeUploader(),
      );
      final manifest = UploadManifest.empty.withUploaded([
        UploadedAsset(
          mediaId: 'a1',
          objectPath: 'p/a1',
          sizeBytes: 1,
          uploadedAt: DateTime(2026),
        ),
      ]);
      final res = await coordinator.ensureUploaded(
        assets: [_asset('a1')],
        manifest: manifest,
        ownerUid: 'u',
        projectId: 'p1',
      );
      expect(up.requested, isEmpty, reason: 'ни одного запроса /uploads');
      expect(res.uploaded, isEmpty);
      expect(res.objectPaths['a1'], 'p/a1');
    });
  });
}
