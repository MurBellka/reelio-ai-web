import 'export_settings.dart';

/// Версия контракта рендера (`docs/render-contract.md`), которую понимает клиент.
///
/// Правило совместимости контракта: неизвестные поля ответов **игнорируются**,
/// поэтому парсинг ниже читает только описанные в документе ключи.
const int kRenderContractVersion = 1;

/// Статус задачи рендера (§4.1 контракта).
enum RenderStatus {
  queued,
  running,
  succeeded,
  failed,
  cancelled;

  /// Терминальные статусы неизменяемы — поллинг после них прекращается.
  bool get isTerminal =>
      this == RenderStatus.succeeded ||
      this == RenderStatus.failed ||
      this == RenderStatus.cancelled;

  bool get isActive => !isTerminal;

  /// Неизвестный (например, добавленный в будущей минорной версии) статус
  /// трактуется как `queued`: задача считается активной, поллинг продолжится
  /// до собственного таймаута клиента.
  ///
  /// `completed` принимается как синоним `succeeded`: контракт называет
  /// успешное терминальное состояние `succeeded`, но клиент не должен считать
  /// MP4 готовым ни в каком другом случае, поэтому оба написания сводятся к
  /// одному статусу.
  static RenderStatus fromWire(String? value) {
    if (value == 'completed') return RenderStatus.succeeded;
    return RenderStatus.values.firstWhere(
      (e) => e.name == value,
      orElse: () => RenderStatus.queued,
    );
  }
}

/// Этап рендера (§4.2 контракта).
///
/// [from]..[to] — фиксированный вклад этапа в общий `progress`, благодаря
/// которому полоса в UI движется ровно, без скачков.
enum RenderPhase {
  queued('В очереди', 0.00, 0.05, RenderStatus.queued),
  preparing('Подготовка', 0.05, 0.10, RenderStatus.running),
  downloading('Загрузка исходников', 0.10, 0.30, RenderStatus.running),
  rendering('Монтаж', 0.30, 0.60, RenderStatus.running),
  encoding('Кодирование', 0.60, 0.90, RenderStatus.running),
  uploading('Выгрузка', 0.90, 0.98, RenderStatus.running),
  finalizing('Финализация', 0.98, 1.00, RenderStatus.running),
  done('Готово', 1.00, 1.00, RenderStatus.succeeded),
  failed('Ошибка', 0.00, 1.00, RenderStatus.failed),
  cancelled('Отменено', 0.00, 1.00, RenderStatus.cancelled);

  const RenderPhase(this.label, this.from, this.to, this.status);

  /// Человекочитаемая подпись этапа для UI.
  final String label;

  /// Нижняя граница вклада этапа в общий прогресс.
  final double from;

  /// Верхняя граница вклада этапа в общий прогресс.
  final double to;

  /// Статус задачи, которому соответствует этап.
  final RenderStatus status;

  /// Отображает прогресс **внутри** этапа (0..1) в общий прогресс задачи.
  double globalProgress(double fraction) {
    final f = fraction.isNaN ? 0.0 : fraction.clamp(0.0, 1.0);
    return from + (to - from) * f;
  }

  static RenderPhase fromWire(String? value) => RenderPhase.values.firstWhere(
    (e) => e.name == value,
    orElse: () => RenderPhase.queued,
  );
}

/// Ошибка контракта (§7): единый конверт для всех не-2xx ответов API и для
/// поля `RenderJob.error`.
class RenderError {
  const RenderError({
    required this.code,
    required this.message,
    this.field,
    this.retryable = false,
    this.jobId,
    this.requestId,
  });

  /// Стабильный машинный код, SCREAMING_SNAKE (`PLAN_INVALID`, `INTERNAL`, …).
  final String code;

  /// Сообщение для пользователя (русский, без секретов).
  final String message;

  /// Путь до проблемного поля запроса, если применимо.
  final String? field;

  /// Имеет ли смысл повтор запроса.
  final bool retryable;

  final String? jobId;

  /// Идентификатор запроса для корреляции с логами сервера.
  final String? requestId;

  /// Локальная (не серверная) ошибка — сеть, таймаут, битый ответ.
  factory RenderError.local(String message, {bool retryable = true}) =>
      RenderError(code: 'CLIENT_ERROR', message: message, retryable: retryable);

  /// Разбирает как конверт `{"error": {...}}`, так и «голый» объект ошибки.
  ///
  /// Возвращает `null`, если это не ошибка контракта.
  static RenderError? tryParse(Object? json) {
    if (json is! Map) return null;
    final nested = json['error'];
    final raw = nested is Map ? nested : json;
    final code = raw['code'];
    if (code is! String || code.isEmpty) return null;
    return RenderError(
      code: code,
      message: raw['message'] as String? ?? 'Сервер вернул ошибку рендера.',
      field: raw['field'] as String?,
      retryable: raw['retryable'] as bool? ?? false,
      jobId: raw['jobId'] as String?,
      requestId: raw['requestId'] as String?,
    );
  }

  @override
  String toString() => '$code: $message';
}

/// Готовый результат рендера (§4.3).
class RenderResult {
  const RenderResult({
    required this.objectPath,
    required this.sizeBytes,
    required this.durationSeconds,
    required this.width,
    required this.height,
    required this.fps,
    this.downloadUrl,
    this.downloadUrlExpiresAt,
    this.thumbnailObjectPath,
    this.thumbnailUrl,
    this.videoCodec = 'h264',
    this.audioCodec = 'aac',
    this.checksumCrc32c,
    this.renderedAt,
  });

  final String objectPath;

  /// Signed URL с ограниченным сроком жизни. Кэшировать его нельзя —
  /// перед скачиванием клиент обязан перезапросить `GET /download`.
  final String? downloadUrl;
  final DateTime? downloadUrlExpiresAt;

  final String? thumbnailObjectPath;
  final String? thumbnailUrl;

  final int sizeBytes;
  final double durationSeconds;
  final int width;
  final int height;
  final int fps;
  final String videoCodec;
  final String audioCodec;
  final String? checksumCrc32c;
  final DateTime? renderedAt;

  /// Просрочен ли выданный signed URL.
  bool get isDownloadUrlExpired {
    final expires = downloadUrlExpiresAt;
    if (expires == null) return false;
    return !expires.isAfter(DateTime.now().toUtc());
  }

  /// Имя файла для сохранения: `reelio_1080p.mp4`.
  String get fileName => 'reelio_${height}p.mp4';

  static RenderResult? tryParse(Object? json) {
    if (json is! Map) return null;
    final objectPath = json['objectPath'];
    if (objectPath is! String || objectPath.isEmpty) return null;
    return RenderResult(
      objectPath: objectPath,
      downloadUrl: json['downloadUrl'] as String?,
      downloadUrlExpiresAt: _parseTime(json['downloadUrlExpiresAt']),
      thumbnailObjectPath: json['thumbnailObjectPath'] as String?,
      thumbnailUrl: json['thumbnailUrl'] as String?,
      sizeBytes: (json['sizeBytes'] as num?)?.toInt() ?? 0,
      durationSeconds: (json['durationSeconds'] as num?)?.toDouble() ?? 0,
      width: (json['width'] as num?)?.toInt() ?? 0,
      height: (json['height'] as num?)?.toInt() ?? 0,
      fps: (json['fps'] as num?)?.toInt() ?? 30,
      videoCodec: json['videoCodec'] as String? ?? 'h264',
      audioCodec: json['audioCodec'] as String? ?? 'aac',
      checksumCrc32c: json['checksumCrc32c'] as String?,
      renderedAt: _parseTime(json['renderedAt']),
    );
  }
}

/// Состояние задачи рендера (§4) — то, что клиент получает из `POST /render`,
/// `GET /jobs/{id}` и `POST /jobs/{id}/cancel`.
class RenderJob {
  const RenderJob({
    required this.jobId,
    required this.projectId,
    required this.status,
    required this.phase,
    required this.progress,
    required this.export,
    this.contractVersion = kRenderContractVersion,
    this.planId,
    this.message = '',
    this.attempt = 1,
    this.createdAt,
    this.updatedAt,
    this.startedAt,
    this.finishedAt,
    this.expiresAt,
    this.result,
    this.error,
    this.cancelRequested = false,
  });

  final int contractVersion;
  final String jobId;
  final String projectId;
  final String? planId;

  final RenderStatus status;
  final RenderPhase phase;

  /// 0.0..1.0, монотонно не убывает.
  final double progress;

  /// Человекочитаемое сообщение сервера для UI.
  final String message;

  /// Резолвнутые (всегда конкретные) параметры экспорта.
  final ExportSettings export;

  final int attempt;
  final DateTime? createdAt;
  final DateTime? updatedAt;
  final DateTime? startedAt;
  final DateTime? finishedAt;

  /// TTL артефактов задачи (§6): после этого момента результат удаляется.
  final DateTime? expiresAt;

  final RenderResult? result;
  final RenderError? error;

  /// Отмена запрошена, но worker ещё не подтвердил остановку.
  final bool cancelRequested;

  bool get isTerminal => status.isTerminal;
  bool get isActive => status.isActive;
  bool get isSucceeded => status == RenderStatus.succeeded;
  bool get isFailed => status == RenderStatus.failed;
  bool get isCancelled => status == RenderStatus.cancelled;

  /// Истёк ли срок жизни артефактов задачи.
  bool get isExpired {
    final expires = expiresAt;
    if (expires == null) return false;
    return !expires.isAfter(DateTime.now().toUtc());
  }

  /// Можно ли повторить задачу: провал или отмена — терминальные состояния,
  /// из которых сервер создаёт новую задачу (§5, правило 3).
  bool get canRetry => isFailed || isCancelled;

  factory RenderJob.fromJson(Map<String, dynamic> json) {
    final status = RenderStatus.fromWire(json['status'] as String?);
    final phase = RenderPhase.fromWire(json['phase'] as String?);
    final rawProgress = (json['progress'] as num?)?.toDouble();
    return RenderJob(
      contractVersion:
          (json['contractVersion'] as num?)?.toInt() ?? kRenderContractVersion,
      jobId: json['jobId'] as String? ?? '',
      projectId: json['projectId'] as String? ?? '',
      planId: json['planId'] as String?,
      status: status,
      phase: phase,
      progress: (rawProgress ?? phase.from).clamp(0.0, 1.0),
      message: json['message'] as String? ?? '',
      export: json['export'] is Map
          ? ExportSettings.fromJson(
              (json['export'] as Map).cast<String, dynamic>(),
            )
          : ExportSettings.defaults,
      attempt: (json['attempt'] as num?)?.toInt() ?? 1,
      createdAt: _parseTime(json['createdAt']),
      updatedAt: _parseTime(json['updatedAt']),
      startedAt: _parseTime(json['startedAt']),
      finishedAt: _parseTime(json['finishedAt']),
      expiresAt: _parseTime(json['expiresAt']),
      result: RenderResult.tryParse(json['result']),
      error: RenderError.tryParse(json['error']),
      cancelRequested: json['cancelRequested'] as bool? ?? false,
    );
  }
}

DateTime? _parseTime(Object? value) {
  if (value is! String || value.isEmpty) return null;
  return DateTime.tryParse(value)?.toUtc();
}
