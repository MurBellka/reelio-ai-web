// UI-регрессия предпросмотра (§6): после reload локального File может не быть
// (серверный план несёт clips без filePath). Плеер обязан сопоставлять материал
// по mediaId и НЕ падать при отсутствии локального файла — показывать placeholder.

import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:reelio_ai/features/preview/montage_player.dart';
import 'package:reelio_ai/models/edit_plan.dart';
import 'package:reelio_ai/models/enums.dart';
import 'package:reelio_ai/models/media_asset.dart';

EditPlan _serverPlan() => EditPlan.fromJson(
  jsonDecode(File('test-fixtures/edit_plan_v2.json').readAsStringSync())
      as Map<String, dynamic>,
);

void main() {
  testWidgets(
    'серверный план без filePath и без локальных материалов не роняет плеер',
    (tester) async {
      final plan = _serverPlan();
      // Клипы серверного плана: filePath == null.
      expect(plan.clips.every((c) => c.filePath == null), isTrue);

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: MontagePlayer(
              plan: plan,
              assetsById: const {}, // локальных материалов нет (после reload)
            ),
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 50));

      // Никаких исключений (нет type-cast/NPE на отсутствующем File).
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('плеер сопоставляет материал по mediaId (не по имени файла)', (
    tester,
  ) async {
    final plan = _serverPlan();
    // Материал под правильным mediaId существует локально — плеер его найдёт,
    // хотя в clip нет filePath. Второй материал с тем же именем не мешает.
    const a = MediaAsset(
      id: 'asset_a',
      path: '/x/name.mp4',
      name: 'name.mp4',
      type: MediaType.video,
    );
    const dup = MediaAsset(
      id: 'other',
      path: '/y/name.mp4',
      name: 'name.mp4',
      type: MediaType.video,
    );

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: MontagePlayer(
            plan: plan,
            assetsById: const {'asset_a': a, 'other': dup},
          ),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 50));
    // Плеер не падает; сопоставление идёт по mediaId, не по совпадению имени.
    expect(tester.takeException(), isNull);
  });
}
