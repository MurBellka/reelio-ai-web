// Текстовые слои v2 (§4), каталог шрифтов (§5) и шаблоны. Координаты — доли
// кадра, поэтому раскладка одинакова в 720p…4K; безопасная зона Reels
// проверяется отдельно.

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:reelio_ai/models/edit_plan.dart';
import 'package:reelio_ai/models/enums.dart';
import 'package:reelio_ai/models/font_catalog.dart';
import 'package:reelio_ai/models/text_overlay.dart';
import 'package:reelio_ai/models/text_template.dart';
import 'package:reelio_ai/state/providers.dart';
import 'package:shared_preferences/shared_preferences.dart';

EditPlan _emptyPlan() => const EditPlan(
  id: 'plan_1',
  prompt: 'тест',
  style: EditStyle.dynamicStyle,
  durationSeconds: 12,
  captions: CaptionSettings.defaults,
  audio: AudioSettings.defaults,
  coverClipId: 'c1',
  clips: [
    EditClip(
      id: 'c1',
      filePath: '/a.mp4',
      type: MediaType.video,
      duration: 12,
      transition: 'cut',
      mediaId: 'a',
      start: 0,
      end: 12,
    ),
  ],
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('Каталог шрифтов (§5)', () {
    test('девять семейств с кириллицей', () {
      expect(FontFamilyId.values, hasLength(9));
    });

    test('storageValue уникален; лицензия — OFL', () {
      final ids = FontFamilyId.values.map((f) => f.storageValue).toList();
      expect(ids.toSet().length, ids.length);
      for (final f in FontFamilyId.values) {
        expect(f.license, 'OFL 1.1');
      }
    });

    test('fromStorage: известное семейство и запасной inter', () {
      expect(FontFamilyId.fromStorage('oswald'), FontFamilyId.oswald);
      expect(FontFamilyId.fromStorage('pt_sans'), FontFamilyId.ptSans);
      expect(FontFamilyId.fromStorage('нет такого'), FontFamilyId.inter);
      expect(FontFamilyId.fromStorage(null), FontFamilyId.inter);
    });
  });

  group('Безопасная зона Reels (§4.2)', () {
    test('границы совпадают с контрактом', () {
      expect(ReelsSafeZone.top, 0.14);
      expect(ReelsSafeZone.bottom, 0.20);
      expect(ReelsSafeZone.left, 0.06);
      expect(ReelsSafeZone.right, 0.06);
    });

    test('центр внутри и снаружи зоны', () {
      expect(ReelsSafeZone.contains(0.5, 0.5), isTrue);
      expect(ReelsSafeZone.contains(0.5, 0.02), isFalse); // слишком высоко
      expect(ReelsSafeZone.contains(0.02, 0.5), isFalse); // слишком слева
    });

    test('clampY загоняет якорь bottom внутрь зоны', () {
      // bottom.defaultY = 0.80, а нижняя граница зоны = 0.80 — на грани.
      expect(ReelsSafeZone.clampY(0.95), 0.80);
      expect(ReelsSafeZone.clampY(0.05), 0.14);
    });
  });

  group('TextOverlay (§4)', () {
    test('дефолты разумны и в пределах', () {
      const o = TextOverlay(id: 't1', text: 'Привет');
      expect(o.opacity, 1.0);
      expect(o.fontSizeRatio, inInclusiveRange(0.02, 0.15));
      expect(o.anchor, TextAnchor.bottom);
    });

    test('copyWith зажимает координаты, кегль и прозрачность', () {
      const o = TextOverlay(id: 't1', text: 'x');
      final moved = o.copyWith(x: 1.5, y: -0.3);
      expect(moved.x, 1.0);
      expect(moved.y, 0.0);
      expect(o.copyWith(fontSizeRatio: 0.3).fontSizeRatio, 0.15);
      expect(o.copyWith(fontSizeRatio: 0.001).fontSizeRatio, 0.02);
      expect(o.copyWith(opacity: 2).opacity, 1.0);
    });

    test('copyWith умеет снимать плашку (передан null)', () {
      const o = TextOverlay(id: 't1', text: 'x', background: TextBackground());
      expect(o.copyWith(background: null).background, isNull);
      // Без аргумента плашка сохраняется.
      expect(o.copyWith(text: 'y').background, isNotNull);
    });

    test('круговой рейс JSON сохраняет вложенное оформление', () {
      const o = TextOverlay(
        id: 't1',
        text: 'Наша поездка',
        anchor: TextAnchor.top,
        x: 0.4,
        y: 0.2,
        fontId: FontFamilyId.oswald,
        fontWeight: TextWeight.medium,
        fontSizeRatio: 0.06,
        colorHex: '#C4F82A',
        align: TextAlignH.left,
        opacity: 0.9,
        background: TextBackground(opacity: 0.5),
        outline: TextOutline(widthRatio: 0.005),
        shadow: TextShadowSpec(),
        animation: TextAnimation.slide,
      );
      final r = TextOverlay.fromJson(o.toJson());
      expect(r.text, 'Наша поездка');
      expect(r.anchor, TextAnchor.top);
      expect(r.x, 0.4);
      expect(r.fontId, FontFamilyId.oswald);
      expect(r.fontWeight, TextWeight.medium);
      expect(r.align, TextAlignH.left);
      expect(r.opacity, 0.9);
      expect(r.background!.opacity, 0.5);
      expect(r.outline!.widthRatio, 0.005);
      expect(r.shadow, isNotNull);
      expect(r.animation, TextAnimation.slide);
    });

    test('fromJson без position берёт y из якоря', () {
      final r = TextOverlay.fromJson({
        'id': 't1',
        'text': 'x',
        'position': {'anchor': 'center'},
      });
      expect(r.anchor, TextAnchor.center);
      expect(r.y, TextAnchor.center.defaultY);
    });
  });

  group('Шаблоны (девять)', () {
    test('ровно девять уникальных шаблонов', () {
      expect(TextTemplate.values, hasLength(9));
      final ids = TextTemplate.values.map((t) => t.storageValue).toList();
      expect(ids.toSet().length, ids.length);
    });

    test('build применяет стиль и держит текст внутри зоны', () {
      for (final t in TextTemplate.values) {
        final o = t.build(id: 'x', text: 'Заголовок');
        expect(o.fontId, t.fontId);
        expect(o.colorHex, t.colorHex);
        expect(o.animation, t.animation);
        expect(o.fontSizeRatio, inInclusiveRange(0.02, 0.15));
        // Стартовая позиция — внутри безопасной зоны.
        expect(ReelsSafeZone.contains(o.x, o.y), isTrue);
      }
    });

    test('плашка/обводка/тень достаются нужным шаблонам', () {
      expect(TextTemplate.boldCenter.background, isNotNull);
      expect(TextTemplate.caption.background, isNotNull);
      expect(TextTemplate.neon.outline, isNotNull);
      expect(TextTemplate.headline.shadow, isNotNull);
      expect(TextTemplate.minimal.background, isNull);
    });
  });

  group('EditPlan.textOverlays', () {
    test('по умолчанию пусто и переживает круговой рейс', () {
      expect(_emptyPlan().textOverlays, isEmpty);
      final plan = _emptyPlan().copyWith(
        textOverlays: [
          TextTemplate.headline.build(id: 'a', text: 'Раз'),
          TextTemplate.caption.build(id: 'b', text: 'Два'),
        ],
      );
      final r = EditPlan.fromJson(plan.toJson());
      expect(r.textOverlays, hasLength(2));
      expect(r.textOverlays.first.text, 'Раз');
      expect(r.textOverlays.last.fontId, FontFamilyId.ptSans);
    });
  });

  group('ProjectController: текстовые слои', () {
    setUp(() => SharedPreferences.setMockInitialValues({}));

    ProjectController withPlan() {
      final container = ProviderContainer();
      addTearDown(container.dispose);
      final c = container.read(projectProvider.notifier);
      c.setPlan(_emptyPlan());
      return c;
    }

    test('добавление, правка и удаление', () {
      final c = withPlan();
      final o = TextTemplate.headline.build(id: 'a', text: 'Раз');
      expect(c.addTextOverlay(o), isTrue);
      expect(c.state.plan!.textOverlays, hasLength(1));

      c.updateTextOverlay(o.copyWith(text: 'Обновлено'));
      expect(c.state.plan!.textOverlays.single.text, 'Обновлено');

      c.removeTextOverlay('a');
      expect(c.state.plan!.textOverlays, isEmpty);
    });

    test('перетаскивание меняет и зажимает координаты', () {
      final c = withPlan();
      c.addTextOverlay(TextTemplate.minimal.build(id: 'a', text: 'x'));
      c.repositionTextOverlay('a', 1.4, -0.2);
      final o = c.state.plan!.textOverlays.single;
      expect(o.x, 1.0);
      expect(o.y, 0.0);
    });

    test('потолок в 20 слоёв', () {
      final c = withPlan();
      for (var i = 0; i < ProjectController.maxTextOverlays; i++) {
        expect(
          c.addTextOverlay(TextTemplate.caption.build(id: 'o$i', text: '$i')),
          isTrue,
        );
      }
      expect(c.state.plan!.textOverlays, hasLength(20));
      // 21-й не добавляется.
      expect(
        c.addTextOverlay(TextTemplate.caption.build(id: 'over', text: '!')),
        isFalse,
      );
      expect(c.state.plan!.textOverlays, hasLength(20));
    });
  });
}
