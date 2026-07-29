// §4D UX: экран обработки показывает два раздельных, доступных этапа и
// внятные состояния ошибки/повтора. Ширины 320–430 px.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:reelio_ai/features/processing/processing_screen.dart';
import 'package:reelio_ai/models/edit_plan.dart';
import 'package:reelio_ai/models/edit_request.dart';
import 'package:reelio_ai/models/enums.dart';
import 'package:reelio_ai/models/media_asset.dart';
import 'package:reelio_ai/models/upload_ticket.dart';
import 'package:reelio_ai/services/ai_editing_service.dart';
import 'package:reelio_ai/services/media_upload_service.dart';
import 'package:reelio_ai/state/auth_providers.dart';
import 'package:reelio_ai/state/providers.dart';

MediaAsset _asset(String id) => MediaAsset(
  id: id,
  path: '/local/$id.mp4',
  name: '$id.mp4',
  type: MediaType.video,
  durationSeconds: 5,
);

EditPlan _plan() => EditPlan(
  id: 'plan_1',
  prompt: 'тест',
  style: EditStyle.dynamicStyle,
  durationSeconds: 8,
  captions: CaptionSettings.defaults,
  audio: AudioSettings.defaults,
  coverClipId: 'c1',
  clips: const [
    EditClip(
      id: 'c1',
      filePath: '/local/a1.mp4',
      type: MediaType.video,
      duration: 8,
      transition: 'cut',
      mediaId: 'a1',
      start: 0,
      end: 8,
    ),
  ],
);

/// Сообщает прогресс загрузки и зависает на [hold] — экран остаётся на этапе
/// загрузки, до готового плана (и навигации) дело не доходит.
class _HoldingService implements AiEditingService {
  _HoldingService(this.hold);
  final Completer<void> hold;

  @override
  bool get isDemo => false;
  @override
  void cancel() {}

  @override
  Future<EditPlan> createEditPlan(
    EditRequest request, {
    ProcessingReporter? onProgress,
  }) async {
    onProgress?.call(
      ProcessingProgress.uploading(
        const UploadProgress(
          completedFiles: 0,
          totalFiles: 2,
          currentFileName: 'a1.mp4',
          currentFileFraction: 0.4,
        ),
      ),
    );
    await hold.future;
    return _plan();
  }
}

/// Сразу падает ошибкой этапа загрузки.
class _UploadFailService implements AiEditingService {
  @override
  bool get isDemo => false;
  @override
  void cancel() {}
  @override
  Future<EditPlan> createEditPlan(
    EditRequest request, {
    ProcessingReporter? onProgress,
  }) async {
    onProgress?.call(
      ProcessingProgress.uploading(
        const UploadProgress(
          completedFiles: 0,
          totalFiles: 1,
          currentFileName: 'a1.mp4',
        ),
      ),
    );
    await Future<void>.delayed(const Duration(milliseconds: 1));
    throw const MediaUploadException('Хранилище отклонило загрузку «a1.mp4».');
  }
}

Future<ProviderContainer> _pump(
  WidgetTester tester,
  AiEditingService service, {
  Size size = const Size(360, 780),
}) async {
  await tester.binding.setSurfaceSize(size);
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final container = ProviderContainer(
    overrides: [
      aiServiceProvider.overrideWith((ref) => service),
      currentUidProvider.overrideWith((ref) => 'u'),
    ],
  );
  addTearDown(container.dispose);
  container.read(projectProvider.notifier).addAssets([_asset('a1')]);
  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: const MaterialApp(home: ProcessingScreen()),
    ),
  );
  await tester.pump(); // postFrame → start
  await tester.pump(const Duration(milliseconds: 5));
  await tester.pump(const Duration(milliseconds: 5));
  return container;
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('два раздельных этапа с доступными полосами прогресса', (
    tester,
  ) async {
    final hold = Completer<void>();
    await _pump(tester, _HoldingService(hold), size: const Size(320, 720));

    // Обе полосы этапов на экране.
    expect(find.text('Загрузка материалов'), findsOneWidget);
    expect(find.text('AI анализирует материалы'), findsOneWidget);
    // Счётчик «загружено X из N» и имя файла — без внутренних путей.
    expect(find.textContaining('Загружено 0 из 2'), findsOneWidget);
    expect(find.textContaining('a1.mp4'), findsOneWidget);
    expect(find.textContaining('/local/'), findsNothing);
    // Доступность: у прогресс-индикаторов есть семантические подписи.
    expect(find.bySemanticsLabel('AI анализирует материалы'), findsWidgets);
    expect(find.bySemanticsLabel('Загрузка материалов'), findsWidgets);
    // Прогресс-индикаторов ровно два (по одному на этап).
    expect(find.byType(LinearProgressIndicator), findsNWidgets(2));

    // Оставляем сервис в подвешенном состоянии — до навигации в предпросмотр
    // (нужен GoRouter) в этом тесте не доходим.
  });

  testWidgets('ошибка загрузки показана как этап загрузки с кнопкой повтора', (
    tester,
  ) async {
    await _pump(tester, _UploadFailService());

    expect(find.text('Ошибка на этапе загрузки'), findsOneWidget);
    expect(find.textContaining('Хранилище отклонило'), findsOneWidget);
    // Понятные действия: назад и повторить.
    expect(find.byType(FilledButton), findsWidgets);
    expect(find.text('Повторить'), findsOneWidget);
    expect(find.text('Назад'), findsOneWidget);
  });
}
