/// Утилиты форматирования для отображения времени и размера.
class Formatters {
  const Formatters._();

  /// Форматирует секунды в `m:ss` или `h:mm:ss`.
  static String duration(double seconds) {
    final total = seconds.round();
    final h = total ~/ 3600;
    final m = (total % 3600) ~/ 60;
    final s = total % 60;
    final ss = s.toString().padLeft(2, '0');
    if (h > 0) {
      final mm = m.toString().padLeft(2, '0');
      return '$h:$mm:$ss';
    }
    return '$m:$ss';
  }

  /// Человекочитаемая длительность вроде «1 мин 30 сек».
  static String durationHuman(double seconds) {
    final total = seconds.round();
    final m = total ~/ 60;
    final s = total % 60;
    if (m > 0 && s > 0) return '$m мин $s сек';
    if (m > 0) return '$m мин';
    return '$s сек';
  }

  /// Имя файла экспортируемого монтажного плана, например
  /// `reelio-edit-plan-2026-07-26.json`.
  static String editPlanFileName(DateTime now) {
    String two(int v) => v.toString().padLeft(2, '0');
    return 'reelio-edit-plan-${now.year}-${two(now.month)}-${two(now.day)}.json';
  }

  /// Демонстрационный размер файла из байтов.
  static String fileSize(int bytes) {
    if (bytes < 1024) return '$bytes Б';
    const units = ['КБ', 'МБ', 'ГБ'];
    double value = bytes / 1024;
    int unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    final formatted = value >= 100
        ? value.toStringAsFixed(0)
        : value.toStringAsFixed(1);
    return '$formatted ${units[unit]}';
  }
}
