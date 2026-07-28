import 'package:flutter_test/flutter_test.dart';
import 'package:reelio_ai/models/edit_plan.dart';
import 'package:reelio_ai/models/edit_request.dart';
import 'package:reelio_ai/models/enums.dart';
import 'package:reelio_ai/models/media_asset.dart';
import 'package:reelio_ai/services/ai_editing_service.dart';
import 'package:reelio_ai/services/gemini_plan_parser.dart';

EditRequest requestWith(List<MediaAsset> assets) => EditRequest(
  assets: assets,
  prompt: 'ролик',
  style: EditStyle.dynamicStyle,
  durationSeconds: 30,
  captions: CaptionSettings.defaults,
  audio: AudioSettings.defaults,
);

final _assets = [
  MediaAsset(
    id: 'v1',
    path: '/v1.mp4',
    name: 'v1.mp4',
    type: MediaType.video,
    durationSeconds: 40,
    width: 1080,
    height: 1920,
  ),
  const MediaAsset(
    id: 'p1',
    path: '/p1.jpg',
    name: 'p1.jpg',
    type: MediaType.photo,
  ),
];

void main() {
  group('Корректный ответ Gemini', () {
    test('маппится в EditPlan', () {
      final json = {
        'durationSeconds': 20,
        'style': 'cinematic',
        'clips': [
          {
            'mediaId': 'v1',
            'start': 2,
            'end': 8,
            'transition': 'crossfade',
            'reason': 'море',
          },
          {'mediaId': 'p1', 'start': 0, 'end': 3, 'transition': 'fade'},
        ],
        'captions': {'enabled': true, 'language': 'ru', 'style': 'bold'},
        'audio': {'keepOriginal': false},
      };
      final plan = parseGeminiPlan(json, request: requestWith(_assets));
      expect(plan.style, EditStyle.cinematic);
      expect(plan.clips, hasLength(2));
      expect(plan.clips.first.mediaId, 'v1');
      expect(plan.audio.keepOriginal, isFalse);
      expect(plan.computedDuration, lessThanOrEqualTo(20.001));
      // 4K не выбирается, т.к. источник 1920 → 1080p максимум.
      expect(plan.export.height, 1920);
    });
  });

  group('Повреждённый / неверный ответ Gemini', () {
    test('не JSON-объект → AiEditingException', () {
      expect(
        () => parseGeminiPlan('oops', request: requestWith(_assets)),
        throwsA(isA<AiEditingException>()),
      );
    });

    test('пустой список клипов → исключение', () {
      expect(
        () => parseGeminiPlan({
          'clips': <dynamic>[],
        }, request: requestWith(_assets)),
        throwsA(isA<AiEditingException>()),
      );
    });

    test('неизвестный mediaId → исключение', () {
      final json = {
        'clips': [
          {'mediaId': 'ghost', 'start': 0, 'end': 3, 'transition': 'cut'},
        ],
      };
      expect(
        () => parseGeminiPlan(json, request: requestWith(_assets)),
        throwsA(isA<AiEditingException>()),
      );
    });

    test('start >= end → исключение', () {
      final json = {
        'clips': [
          {'mediaId': 'v1', 'start': 5, 'end': 5, 'transition': 'cut'},
        ],
      };
      expect(
        () => parseGeminiPlan(json, request: requestWith(_assets)),
        throwsA(isA<AiEditingException>()),
      );
    });

    test('неизвестный переход заменяется на cut', () {
      final json = {
        'clips': [
          {'mediaId': 'v1', 'start': 0, 'end': 4, 'transition': 'zoom-blast'},
        ],
      };
      final plan = parseGeminiPlan(json, request: requestWith(_assets));
      expect(plan.clips.first.transition, 'cut');
    });
  });
}
