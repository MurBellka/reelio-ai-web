import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:reelio_ai/models/enums.dart';
import 'package:reelio_ai/models/render_job.dart';

Map<String, dynamic> jobJson({
  String status = 'running',
  String phase = 'encoding',
  double progress = 0.62,
  Map<String, dynamic>? result,
  Map<String, dynamic>? error,
  bool cancelRequested = false,
}) => {
  'contractVersion': 1,
  'jobId': 'job_01J8',
  'projectId': 'proj_9d1',
  'planId': 'plan_7f3c',
  'status': status,
  'phase': phase,
  'progress': progress,
  'message': 'Кодирование 1080p',
  'export': {
    'resolution': 'fullHd1080',
    'width': 1080,
    'height': 1920,
    'fps': 30,
    'estimatedSizeBytes': 37500000,
    'isUpscale': false,
  },
  'attempt': 1,
  'createdAt': '2026-07-26T15:04:05.000Z',
  'updatedAt': '2026-07-26T15:05:11.400Z',
  'startedAt': '2026-07-26T15:04:07.100Z',
  'finishedAt': null,
  'expiresAt': '2026-08-02T15:04:05.000Z',
  'result': result,
  'error': error,
  'cancelRequested': cancelRequested,
};

Map<String, dynamic> resultJson() => {
  'objectPath': 'projects/proj_9d1/jobs/job_01J8/output/reel_1080p.mp4',
  'downloadUrl': 'https://storage.googleapis.com/signed',
  'downloadUrlExpiresAt': '2126-07-26T16:05:11.000Z',
  'thumbnailObjectPath': 'projects/proj_9d1/jobs/job_01J8/output/thumbnail.jpg',
  'thumbnailUrl': 'https://storage.googleapis.com/thumb',
  'sizeBytes': 36120044,
  'durationSeconds': 29.8,
  'width': 1080,
  'height': 1920,
  'fps': 30,
  'videoCodec': 'h264',
  'audioCodec': 'aac',
  'checksumCrc32c': 'l3q19g==',
  'renderedAt': '2026-07-26T15:06:02.000Z',
};

void main() {
  group('Разбор RenderJob', () {
    test('читает состояние выполняющейся задачи', () {
      final job = RenderJob.fromJson(jobJson());

      expect(job.jobId, 'job_01J8');
      expect(job.planId, 'plan_7f3c');
      expect(job.status, RenderStatus.running);
      expect(job.phase, RenderPhase.encoding);
      expect(job.progress, closeTo(0.62, 1e-9));
      expect(job.export.resolution, ExportResolution.fullHd1080);
      expect(job.export.height, 1920);
      expect(job.isActive, isTrue);
      expect(job.isTerminal, isFalse);
      expect(job.result, isNull);
      expect(job.error, isNull);
    });

    test('игнорирует неизвестные поля будущих версий контракта', () {
      final raw = jobJson()..['somethingNew'] = {'nested': true};
      final job = RenderJob.fromJson(jsonDecode(jsonEncode(raw)));

      expect(job.jobId, 'job_01J8');
      expect(job.status, RenderStatus.running);
    });

    test('успешная задача несёт результат', () {
      final job = RenderJob.fromJson(
        jobJson(
          status: 'succeeded',
          phase: 'done',
          progress: 1,
          result: resultJson(),
        ),
      );

      expect(job.isSucceeded, isTrue);
      expect(job.isTerminal, isTrue);
      expect(job.result, isNotNull);
      expect(job.result!.sizeBytes, 36120044);
      expect(job.result!.width, 1080);
      expect(job.result!.height, 1920);
      expect(job.result!.durationSeconds, closeTo(29.8, 1e-9));
      expect(job.result!.fileName, 'reelio_1920p.mp4');
      expect(job.result!.isDownloadUrlExpired, isFalse);
    });

    test('провалившаяся задача несёт ошибку контракта', () {
      final job = RenderJob.fromJson(
        jobJson(
          status: 'failed',
          phase: 'failed',
          error: {
            'code': 'WORKER_FAILED',
            'message': 'FFmpeg вернул ненулевой код.',
            'retryable': true,
          },
        ),
      );

      expect(job.isFailed, isTrue);
      expect(job.canRetry, isTrue);
      expect(job.error!.code, 'WORKER_FAILED');
      expect(job.error!.retryable, isTrue);
    });

    test('отменённая задача терминальна и допускает повтор', () {
      final job = RenderJob.fromJson(
        jobJson(status: 'cancelled', phase: 'cancelled', cancelRequested: true),
      );

      expect(job.isCancelled, isTrue);
      expect(job.isTerminal, isTrue);
      expect(job.canRetry, isTrue);
      expect(job.cancelRequested, isTrue);
    });

    test('без progress прогресс берётся из нижней границы этапа', () {
      final raw = jobJson()..remove('progress');
      final job = RenderJob.fromJson(raw);

      expect(job.progress, closeTo(RenderPhase.encoding.from, 1e-9));
    });

    test('истёкший срок хранения виден клиенту', () {
      final raw = jobJson()..['expiresAt'] = '2000-01-01T00:00:00.000Z';
      expect(RenderJob.fromJson(raw).isExpired, isTrue);
    });
  });

  group('Статусы и этапы', () {
    test('терминальны только succeeded, failed и cancelled', () {
      expect(RenderStatus.queued.isTerminal, isFalse);
      expect(RenderStatus.running.isTerminal, isFalse);
      expect(RenderStatus.succeeded.isTerminal, isTrue);
      expect(RenderStatus.failed.isTerminal, isTrue);
      expect(RenderStatus.cancelled.isTerminal, isTrue);
    });

    test('completed трактуется как succeeded', () {
      expect(RenderStatus.fromWire('completed'), RenderStatus.succeeded);
    });

    test('неизвестный статус не выдаётся за готовность', () {
      final status = RenderStatus.fromWire('teleported');
      expect(status.isTerminal, isFalse);
      expect(status, isNot(RenderStatus.succeeded));
    });

    test('диапазоны этапов совпадают с контрактом', () {
      expect(RenderPhase.queued.from, 0.0);
      expect(RenderPhase.queued.to, closeTo(0.05, 1e-9));
      expect(RenderPhase.downloading.to, closeTo(0.30, 1e-9));
      expect(RenderPhase.rendering.to, closeTo(0.60, 1e-9));
      expect(RenderPhase.encoding.to, closeTo(0.90, 1e-9));
      expect(RenderPhase.uploading.to, closeTo(0.98, 1e-9));
      expect(RenderPhase.finalizing.to, 1.0);
      expect(RenderPhase.done.from, 1.0);
    });

    test('этапы идут без разрывов', () {
      const ordered = [
        RenderPhase.queued,
        RenderPhase.preparing,
        RenderPhase.downloading,
        RenderPhase.rendering,
        RenderPhase.encoding,
        RenderPhase.uploading,
        RenderPhase.finalizing,
      ];
      for (var i = 1; i < ordered.length; i++) {
        expect(ordered[i].from, closeTo(ordered[i - 1].to, 1e-9));
      }
    });

    test('прогресс внутри этапа отображается в общий диапазон', () {
      expect(RenderPhase.encoding.globalProgress(0), closeTo(0.60, 1e-9));
      expect(RenderPhase.encoding.globalProgress(0.5), closeTo(0.75, 1e-9));
      expect(RenderPhase.encoding.globalProgress(1), closeTo(0.90, 1e-9));
      // Выход за границы не ломает полосу прогресса.
      expect(RenderPhase.encoding.globalProgress(4), closeTo(0.90, 1e-9));
    });

    test('каждому этапу соответствует статус контракта', () {
      expect(RenderPhase.done.status, RenderStatus.succeeded);
      expect(RenderPhase.failed.status, RenderStatus.failed);
      expect(RenderPhase.cancelled.status, RenderStatus.cancelled);
      expect(RenderPhase.encoding.status, RenderStatus.running);
    });
  });

  group('Разбор ошибок контракта', () {
    test('читает конверт {"error": {...}}', () {
      final error = RenderError.tryParse({
        'error': {
          'code': 'PLAN_INVALID',
          'message': 'Клип ссылается на неизвестный mediaId.',
          'field': 'plan.clips[2].mediaId',
          'retryable': false,
          'requestId': 'req_5f2',
        },
      });

      expect(error, isNotNull);
      expect(error!.code, 'PLAN_INVALID');
      expect(error.field, 'plan.clips[2].mediaId');
      expect(error.retryable, isFalse);
      expect(error.requestId, 'req_5f2');
    });

    test('читает «голый» объект ошибки из RenderJob', () {
      final error = RenderError.tryParse({
        'code': 'TOO_MANY_ACTIVE_JOBS',
        'message': 'Слишком много активных задач.',
        'retryable': true,
      });

      expect(error!.code, 'TOO_MANY_ACTIVE_JOBS');
      expect(error.retryable, isTrue);
    });

    test('не считает ошибкой посторонний JSON', () {
      expect(RenderError.tryParse({'ok': true}), isNull);
      expect(RenderError.tryParse('строка'), isNull);
      expect(RenderError.tryParse(null), isNull);
    });
  });
}
