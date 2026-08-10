import 'package:flutter/material.dart';

/// Группы каталога переходов (контракт v2 §2.1). Служат для раскладки
/// выбора переходов в редакторе по смысловым разделам.
enum TransitionGroup {
  basic('Базовые'),
  fade('Затемнения'),
  wipe('Шторки'),
  slide('Сдвиги'),
  smooth('Плавные'),
  circle('Круг'),
  zoom('Масштаб'),
  effect('Эффекты');

  const TransitionGroup(this.label);
  final String label;
}

/// Каталог переходов v2 (§2.1) — пересечение таблицы контракта с тем, что
/// реально умеет `xfade`. Клип хранит переход строкой ([storageValue]);
/// это допустимая форма v2 (§2: «строка вместо объекта тоже принимается»)
/// и означает переход с интенсивностью `balanced` и длительностью по
/// умолчанию — конкретику выбирает worker.
///
/// `crossfade` из v1 — синоним `dissolve`, поэтому отдельным элементом
/// каталога не показывается, но принимается при чтении ([fromStorage]).
enum TransitionType {
  cut('cut', 'Встык', TransitionGroup.basic, Icons.content_cut_rounded),
  dissolve(
    'dissolve',
    'Растворение',
    TransitionGroup.basic,
    Icons.blur_on_rounded,
  ),
  fadeBlack(
    'fadeBlack',
    'В чёрное',
    TransitionGroup.fade,
    Icons.dark_mode_rounded,
  ),
  fadeWhite(
    'fadeWhite',
    'В белое',
    TransitionGroup.fade,
    Icons.light_mode_rounded,
  ),
  wipeLeft('wipeLeft', 'Штора влево', TransitionGroup.wipe, Icons.west_rounded),
  wipeRight(
    'wipeRight',
    'Штора вправо',
    TransitionGroup.wipe,
    Icons.east_rounded,
  ),
  wipeUp('wipeUp', 'Штора вверх', TransitionGroup.wipe, Icons.north_rounded),
  wipeDown('wipeDown', 'Штора вниз', TransitionGroup.wipe, Icons.south_rounded),
  slideLeft(
    'slideLeft',
    'Сдвиг влево',
    TransitionGroup.slide,
    Icons.keyboard_arrow_left_rounded,
  ),
  slideRight(
    'slideRight',
    'Сдвиг вправо',
    TransitionGroup.slide,
    Icons.keyboard_arrow_right_rounded,
  ),
  slideUp(
    'slideUp',
    'Сдвиг вверх',
    TransitionGroup.slide,
    Icons.keyboard_arrow_up_rounded,
  ),
  slideDown(
    'slideDown',
    'Сдвиг вниз',
    TransitionGroup.slide,
    Icons.keyboard_arrow_down_rounded,
  ),
  smoothLeft(
    'smoothLeft',
    'Плавно влево',
    TransitionGroup.smooth,
    Icons.waves_rounded,
  ),
  smoothRight(
    'smoothRight',
    'Плавно вправо',
    TransitionGroup.smooth,
    Icons.waves_rounded,
  ),
  smoothUp(
    'smoothUp',
    'Плавно вверх',
    TransitionGroup.smooth,
    Icons.waves_rounded,
  ),
  smoothDown(
    'smoothDown',
    'Плавно вниз',
    TransitionGroup.smooth,
    Icons.waves_rounded,
  ),
  circleOpen(
    'circleOpen',
    'Круг наружу',
    TransitionGroup.circle,
    Icons.circle_outlined,
  ),
  circleClose(
    'circleClose',
    'Круг внутрь',
    TransitionGroup.circle,
    Icons.circle_rounded,
  ),
  zoomIn('zoomIn', 'Наплыв', TransitionGroup.zoom, Icons.zoom_in_rounded),
  pixelize(
    'pixelize',
    'Пиксели',
    TransitionGroup.effect,
    Icons.grid_view_rounded,
  ),
  radial('radial', 'Радиальный', TransitionGroup.effect, Icons.sync_rounded),
  blur('blur', 'Размытие', TransitionGroup.effect, Icons.blur_circular_rounded);

  const TransitionType(this.storageValue, this.label, this.group, this.icon);

  /// Значение поля `transition` в плане (совпадает с `type` контракта §2.1).
  final String storageValue;
  final String label;
  final TransitionGroup group;
  final IconData icon;

  /// Переход по умолчанию, если тип не распознан.
  static const TransitionType fallback = TransitionType.dissolve;

  /// Устаревшие формы v1 (§7): принимаются, но в каталоге не показываются.
  static const Map<String, TransitionType> _aliases = {
    'crossfade': TransitionType.dissolve,
    'fade': TransitionType.fadeBlack,
    'slide': TransitionType.slideLeft,
  };

  /// Разбирает строку перехода: сначала прямое совпадение по [storageValue],
  /// затем устаревшие синонимы v1. Неизвестное значение — [fallback].
  static TransitionType fromStorage(String? value) {
    if (value == null) return fallback;
    for (final t in TransitionType.values) {
      if (t.storageValue == value) return t;
    }
    return _aliases[value] ?? fallback;
  }

  /// Знает ли клиент такой переход (каталог или устаревший синоним). Служит
  /// allowlist'ом при валидации ответа модели.
  static bool isKnownStorage(String? value) =>
      value != null &&
      (_aliases.containsKey(value) ||
          TransitionType.values.any((t) => t.storageValue == value));

  /// Каталог, сгруппированный по разделам — для раскладки в редакторе.
  static Map<TransitionGroup, List<TransitionType>> get byGroup {
    final map = <TransitionGroup, List<TransitionType>>{};
    for (final t in TransitionType.values) {
      map.putIfAbsent(t.group, () => []).add(t);
    }
    return map;
  }
}

/// Интенсивность перехода (контракт v2 §2.1): calm | balanced | dynamic.
enum TransitionIntensity {
  calm('calm'),
  balanced('balanced'),
  dynamicIntensity('dynamic');

  const TransitionIntensity(this.storageValue);
  final String storageValue;

  static TransitionIntensity fromStorage(String? value) {
    for (final i in TransitionIntensity.values) {
      if (i.storageValue == value) return i;
    }
    return TransitionIntensity.balanced;
  }
}

/// Переход клипа как ОБЪЕКТ контракта v2 (§2.1): `{type, durationSeconds,
/// intensity}`.
///
/// Прежде клиент хранил переход строкой и терял `durationSeconds`/`intensity`.
/// `TransitionSpec` сохраняет все три параметра. Читает и объект v2, и строку
/// v1 (обратная совместимость, §7). Неизвестный тип НЕ проглатывается молча:
/// подставляется контрактный [TransitionType.fallback], а причина фиксируется
/// в [note].
class TransitionSpec {
  const TransitionSpec({
    required this.type,
    this.durationSeconds,
    this.intensity = TransitionIntensity.balanced,
    this.note,
  });

  /// Тип перехода (каталог §2.1).
  final TransitionType type;

  /// Длительность 0.15..1.5 c; `null` — worker подставит по [intensity].
  final double? durationSeconds;

  final TransitionIntensity intensity;

  /// Контрактный fallback: заполняется, если исходный тип не распознан.
  final String? note;

  /// Отсутствие перехода (стык). Первый клип плана всегда такой.
  static const TransitionSpec cut = TransitionSpec(type: TransitionType.cut);

  static double? _asDouble(Object? v) {
    if (v is num) return v.toDouble();
    if (v is String) return double.tryParse(v);
    return null;
  }

  /// Разбирает `transition` из плана: объект v2, строку v1 или отсутствие.
  factory TransitionSpec.fromJson(Object? json) {
    if (json is Map) {
      final raw = json['type'];
      final rawStr = raw is String ? raw : null;
      final known = TransitionType.isKnownStorage(rawStr);
      final type = TransitionType.fromStorage(rawStr);
      final dur = _asDouble(json['durationSeconds']);
      return TransitionSpec(
        type: type,
        durationSeconds: dur?.clamp(0.15, 1.5).toDouble(),
        intensity: TransitionIntensity.fromStorage(
          json['intensity'] as String?,
        ),
        note: known
            ? null
            : 'Неизвестный переход «${rawStr ?? raw}» заменён на «${type.storageValue}».',
      );
    }
    // v1: строка вместо объекта (§7 контракта — принимается).
    if (json is String) {
      final known = TransitionType.isKnownStorage(json);
      final type = TransitionType.fromStorage(json);
      return TransitionSpec(
        type: type,
        note: known
            ? null
            : 'Неизвестный переход «$json» заменён на «${type.storageValue}».',
      );
    }
    // Поле отсутствует/невалидно → безопасный стык.
    return TransitionSpec.cut;
  }

  Map<String, dynamic> toJson() => {
    'type': type.storageValue,
    'durationSeconds': durationSeconds,
    'intensity': intensity.storageValue,
  };

  TransitionSpec copyWith({
    TransitionType? type,
    double? durationSeconds,
    TransitionIntensity? intensity,
  }) => TransitionSpec(
    type: type ?? this.type,
    durationSeconds: durationSeconds ?? this.durationSeconds,
    intensity: intensity ?? this.intensity,
    note: note,
  );

  @override
  bool operator ==(Object other) =>
      other is TransitionSpec &&
      other.type == type &&
      other.durationSeconds == durationSeconds &&
      other.intensity == intensity;

  @override
  int get hashCode => Object.hash(type, durationSeconds, intensity);
}
