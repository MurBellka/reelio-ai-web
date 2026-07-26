import 'dart:convert';

import 'package:flutter/foundation.dart' show kIsWeb;

import '../core/platform/file_ops.dart';
import '../models/edit_plan.dart';
import '../models/edit_request.dart';

/// Абстракция экспорта готового ролика.
///
/// В MVP реализация сохраняет монтажный план как JSON. Позднее её можно
/// заменить клиентом серверного рендеринга, вернув настоящий MP4.
abstract class VideoExportService {
  Future<ExportResult> export(EditPlan plan);
}

/// Мок-экспорт: сериализует план во временный каталог приложения.
///
/// Не создаёт настоящий MP4 и явно помечает результат как демонстрационный.
class MockVideoExportService implements VideoExportService {
  const MockVideoExportService();

  @override
  Future<ExportResult> export(EditPlan plan) async {
    await Future<void>.delayed(const Duration(milliseconds: 400));

    final payload = <String, dynamic>{
      'app': 'Reelio AI',
      'kind': 'edit-plan',
      'demo': true,
      'note':
          'Демонстрационный экспорт. Настоящий видеорендеринг будет подключён '
          'через серверный API в следующей версии.',
      'plan': plan.toJson(),
    };
    final json = const JsonEncoder.withIndent('  ').convert(payload);

    // На web нет доступа к файловой системе — план шарится/скачивается из памяти.
    var filePath = '';
    if (!kIsWeb) {
      filePath = await writeTempFile('reelio_plan_${plan.id}.json', json);
    }

    return ExportResult(
      planFilePath: filePath,
      planJson: json,
      estimatedSizeBytes: _estimateSize(plan),
      durationSeconds: plan.computedDuration.round(),
      isDemo: true,
    );
  }

  /// Демонстрационная оценка размера: ~1.6 МБ на секунду 1080p.
  int _estimateSize(EditPlan plan) {
    final seconds = plan.computedDuration.clamp(1, 120);
    return (seconds * 1.6 * 1024 * 1024).round();
  }
}
