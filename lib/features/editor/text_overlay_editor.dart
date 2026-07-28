import 'package:flutter/material.dart';

import '../../core/theme.dart';
import '../../models/edit_plan.dart';
import '../../models/font_catalog.dart';
import '../../models/text_overlay.dart';
import '../../models/text_template.dart';
import '../../shared/reel_preview.dart';

/// Уровень интерфейса редактирования текста (три уровня из задания). Чем выше
/// уровень, тем больше элементов управления показывается — новичку не мешает
/// лишнее, профессионалу доступно всё.
enum EditorLevel {
  simple('Простой'),
  standard('Стандартный'),
  pro('Про');

  const EditorLevel(this.label);
  final String label;
}

Color colorFromHex(String hex) {
  final v = int.tryParse(hex.replaceFirst('#', ''), radix: 16);
  return v == null ? Colors.white : Color(0xFF000000 | v);
}

FontWeight _weightOf(TextWeight w) => switch (w) {
  TextWeight.regular => FontWeight.w400,
  TextWeight.medium => FontWeight.w600,
  TextWeight.bold => FontWeight.w900,
};

TextAlign _alignOf(TextAlignH a) => switch (a) {
  TextAlignH.left => TextAlign.left,
  TextAlignH.center => TextAlign.center,
  TextAlignH.right => TextAlign.right,
};

/// Вертикальная 9:16 сцена с текстовыми слоями. Слои перетаскиваются пальцем;
/// пунктиром показана безопасная зона Reels (§4.2).
class TextStagePreview extends StatelessWidget {
  const TextStagePreview({
    super.key,
    required this.plan,
    required this.onReposition,
    required this.onTapOverlay,
  });

  final EditPlan plan;
  final void Function(String id, double x, double y) onReposition;
  final void Function(TextOverlay overlay) onTapOverlay;

  @override
  Widget build(BuildContext context) {
    return AspectRatio(
      aspectRatio: 9 / 16,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(AppRadius.lg),
        child: LayoutBuilder(
          builder: (context, constraints) {
            final w = constraints.maxWidth;
            final h = constraints.maxHeight;
            return Stack(
              fit: StackFit.expand,
              children: [
                DecoratedBox(
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                      colors: gradientForStyle(plan.style),
                    ),
                  ),
                ),
                // Пунктирная рамка безопасной зоны Reels (§4.2). Positioned —
                // прямой потомок Stack, поэтому rect считаем здесь, где w/h
                // уже известны из LayoutBuilder.
                Positioned.fromRect(
                  rect: Rect.fromLTRB(
                    ReelsSafeZone.left * w,
                    ReelsSafeZone.top * h,
                    w - ReelsSafeZone.right * w,
                    h - ReelsSafeZone.bottom * h,
                  ),
                  child: Container(
                    decoration: BoxDecoration(
                      border: Border.all(
                        color: Colors.white.withValues(alpha: 0.35),
                      ),
                      borderRadius: BorderRadius.circular(6),
                    ),
                  ),
                ),
                for (final overlay in plan.textOverlays)
                  _DraggableOverlay(
                    key: ValueKey(overlay.id),
                    overlay: overlay,
                    stageWidth: w,
                    stageHeight: h,
                    onReposition: onReposition,
                    onTap: () => onTapOverlay(overlay),
                  ),
                if (plan.textOverlays.isEmpty)
                  const Center(
                    child: Padding(
                      padding: EdgeInsets.all(24),
                      child: Text(
                        'Добавьте текст и перетащите его в кадр',
                        textAlign: TextAlign.center,
                        style: TextStyle(color: Colors.white70),
                      ),
                    ),
                  ),
              ],
            );
          },
        ),
      ),
    );
  }
}

class _DraggableOverlay extends StatefulWidget {
  const _DraggableOverlay({
    super.key,
    required this.overlay,
    required this.stageWidth,
    required this.stageHeight,
    required this.onReposition,
    required this.onTap,
  });

  final TextOverlay overlay;
  final double stageWidth;
  final double stageHeight;
  final void Function(String id, double x, double y) onReposition;
  final VoidCallback onTap;

  @override
  State<_DraggableOverlay> createState() => _DraggableOverlayState();
}

class _DraggableOverlayState extends State<_DraggableOverlay> {
  late double _x = widget.overlay.x;
  late double _y = widget.overlay.y;
  bool _dragging = false;

  @override
  void didUpdateWidget(_DraggableOverlay old) {
    super.didUpdateWidget(old);
    // Пока тащим — держим локальную позицию; иначе синхронизируемся с моделью.
    if (!_dragging) {
      _x = widget.overlay.x;
      _y = widget.overlay.y;
    }
  }

  void _onPanUpdate(DragUpdateDetails d) {
    setState(() {
      _dragging = true;
      _x = (_x + d.delta.dx / widget.stageWidth).clamp(0.0, 1.0);
      _y = (_y + d.delta.dy / widget.stageHeight).clamp(0.0, 1.0);
    });
    widget.onReposition(widget.overlay.id, _x, _y);
  }

  @override
  Widget build(BuildContext context) {
    final o = widget.overlay;
    final fontSize = o.fontSizeRatio * widget.stageHeight;
    final inZone = ReelsSafeZone.contains(_x, _y);
    return Align(
      alignment: Alignment(_x * 2 - 1, _y * 2 - 1),
      child: GestureDetector(
        onTap: widget.onTap,
        onPanUpdate: _onPanUpdate,
        onPanEnd: (_) => setState(() => _dragging = false),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
          decoration: BoxDecoration(
            color: o.background == null
                ? (inZone ? null : Colors.red.withValues(alpha: 0.18))
                : colorFromHex(
                    o.background!.colorHex,
                  ).withValues(alpha: o.background!.opacity),
            borderRadius: BorderRadius.circular(6),
            border: inZone
                ? null
                : Border.all(color: Colors.redAccent, width: 1),
          ),
          child: Opacity(
            opacity: o.opacity,
            child: Text(
              o.text.isEmpty ? 'Текст' : o.text,
              textAlign: _alignOf(o.align),
              style: TextStyle(
                color: colorFromHex(o.colorHex),
                fontSize: fontSize.clamp(10.0, 200.0),
                fontWeight: _weightOf(o.fontWeight),
                height: 1.05,
                shadows: o.shadow == null
                    ? const [Shadow(color: Colors.black54, blurRadius: 6)]
                    : [
                        Shadow(
                          color: colorFromHex(o.shadow!.colorHex),
                          blurRadius: 8,
                        ),
                      ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Нижний лист выбора шаблона текста (девять пресетов).
class TextTemplatePickerSheet extends StatelessWidget {
  const TextTemplatePickerSheet({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxHeight: MediaQuery.of(context).size.height * 0.7,
        ),
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.fromLTRB(20, 4, 20, 20),
          children: [
            Text('Шаблон текста', style: theme.textTheme.titleLarge),
            const SizedBox(height: 4),
            Text(
              'Оформление подставится сразу — потом можно поправить',
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 16),
            GridView.count(
              crossAxisCount: 3,
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              mainAxisSpacing: 12,
              crossAxisSpacing: 12,
              childAspectRatio: 0.82,
              children: [
                for (final t in TextTemplate.values)
                  _TemplateCard(
                    template: t,
                    onTap: () => Navigator.of(context).pop(t),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _TemplateCard extends StatelessWidget {
  const _TemplateCard({required this.template, required this.onTap});
  final TextTemplate template;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(AppRadius.md),
      child: Container(
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: theme.colorScheme.surfaceContainerHighest.withValues(
            alpha: 0.5,
          ),
          borderRadius: BorderRadius.circular(AppRadius.md),
          border: Border.all(color: theme.colorScheme.outlineVariant),
        ),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Expanded(
              child: Center(
                child: Text(
                  'Aa',
                  style: TextStyle(
                    color: colorFromHex(template.colorHex),
                    fontWeight: _weightOf(template.weight),
                    fontSize: 30,
                    shadows: const [
                      Shadow(color: Colors.black54, blurRadius: 6),
                    ],
                  ),
                ),
              ),
            ),
            const SizedBox(height: 6),
            Text(
              template.label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.labelMedium,
            ),
            Text(
              template.hint,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.labelSmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Результат листа редактирования слоя: обновлённый слой или запрос удаления.
class TextOverlayEditResult {
  const TextOverlayEditResult({required this.overlay, this.deleted = false});
  final TextOverlay overlay;
  final bool deleted;
}

/// Лист редактирования текстового слоя с тремя уровнями интерфейса.
class TextOverlayEditSheet extends StatefulWidget {
  const TextOverlayEditSheet({super.key, required this.overlay});
  final TextOverlay overlay;

  @override
  State<TextOverlayEditSheet> createState() => _TextOverlayEditSheetState();
}

class _TextOverlayEditSheetState extends State<TextOverlayEditSheet> {
  late TextOverlay _o = widget.overlay;
  late final TextEditingController _controller = TextEditingController(
    text: widget.overlay.text,
  );
  EditorLevel _level = EditorLevel.standard;

  static const _colors = <(String, String)>[
    ('Белый', '#FFFFFF'),
    ('Лайм', '#C4F82A'),
    ('Фиолетовый', '#C4B5FD'),
    ('Жёлтый', '#FFE066'),
    ('Чёрный', '#111111'),
  ];

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _set(TextOverlay next) => setState(() => _o = next);

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final standardUp = _level != EditorLevel.simple;
    final pro = _level == EditorLevel.pro;

    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(
          bottom: MediaQuery.of(context).viewInsets.bottom,
        ),
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxHeight: MediaQuery.of(context).size.height * 0.85,
          ),
          // SingleChildScrollView+Column строит все элементы сразу (в отличие
          // от ленивого ListView), поэтому управление доступно на любом уровне
          // без предварительной прокрутки.
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(20, 4, 20, 20),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text('Текст', style: theme.textTheme.titleLarge),
                    ),
                    TextButton.icon(
                      onPressed: () => Navigator.of(
                        context,
                      ).pop(TextOverlayEditResult(overlay: _o, deleted: true)),
                      style: TextButton.styleFrom(
                        foregroundColor: theme.colorScheme.error,
                      ),
                      icon: const Icon(Icons.delete_outline_rounded),
                      label: const Text('Удалить'),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                // Переключатель уровня интерфейса.
                SegmentedButton<EditorLevel>(
                  segments: [
                    for (final l in EditorLevel.values)
                      ButtonSegment(value: l, label: Text(l.label)),
                  ],
                  selected: {_level},
                  onSelectionChanged: (s) => setState(() => _level = s.first),
                  showSelectedIcon: false,
                ),
                const SizedBox(height: 16),
                TextField(
                  controller: _controller,
                  maxLength: TextOverlay.maxTextLength,
                  maxLines: 2,
                  onChanged: (v) => _set(_o.copyWith(text: v)),
                  decoration: const InputDecoration(
                    labelText: 'Надпись',
                    border: OutlineInputBorder(),
                  ),
                ),
                if (standardUp) ...[
                  const SizedBox(height: 8),
                  _Label('Шрифт'),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      for (final f in FontFamilyId.values)
                        ChoiceChip(
                          label: Text(f.label),
                          selected: _o.fontId == f,
                          onSelected: (_) => _set(_o.copyWith(fontId: f)),
                        ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  _Label('Цвет'),
                  Wrap(
                    spacing: 10,
                    children: [
                      for (final c in _colors)
                        _ColorDot(
                          color: colorFromHex(c.$2),
                          selected:
                              _o.colorHex.toUpperCase() == c.$2.toUpperCase(),
                          onTap: () => _set(_o.copyWith(colorHex: c.$2)),
                        ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  _Label('Размер'),
                  Slider(
                    value: _o.fontSizeRatio,
                    min: TextOverlay.minFontSizeRatio,
                    max: TextOverlay.maxFontSizeRatio,
                    onChanged: (v) => _set(_o.copyWith(fontSizeRatio: v)),
                  ),
                  _Label('Выравнивание'),
                  Wrap(
                    spacing: 8,
                    children: [
                      for (final a in TextAlignH.values)
                        ChoiceChip(
                          label: Text(switch (a) {
                            TextAlignH.left => 'Слева',
                            TextAlignH.center => 'По центру',
                            TextAlignH.right => 'Справа',
                          }),
                          selected: _o.align == a,
                          onSelected: (_) => _set(_o.copyWith(align: a)),
                        ),
                    ],
                  ),
                ],
                if (pro) ...[
                  const SizedBox(height: 12),
                  _Label('Начертание'),
                  Wrap(
                    spacing: 8,
                    children: [
                      for (final w in TextWeight.values)
                        ChoiceChip(
                          label: Text(switch (w) {
                            TextWeight.regular => 'Обычное',
                            TextWeight.medium => 'Среднее',
                            TextWeight.bold => 'Жирное',
                          }),
                          selected: _o.fontWeight == w,
                          onSelected: (_) => _set(_o.copyWith(fontWeight: w)),
                        ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  _Label('Анимация'),
                  Wrap(
                    spacing: 8,
                    children: [
                      for (final an in TextAnimation.values)
                        ChoiceChip(
                          label: Text(an.label),
                          selected: _o.animation == an,
                          onSelected: (_) => _set(_o.copyWith(animation: an)),
                        ),
                    ],
                  ),
                  const SizedBox(height: 4),
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    title: const Text('Плашка под текстом'),
                    value: _o.background != null,
                    onChanged: (v) => _set(
                      _o.copyWith(
                        background: v ? const TextBackground() : null,
                      ),
                    ),
                  ),
                ],
                const SizedBox(height: 12),
                FilledButton(
                  onPressed: () => Navigator.of(
                    context,
                  ).pop(TextOverlayEditResult(overlay: _o)),
                  child: const Text('Готово'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _Label extends StatelessWidget {
  const _Label(this.text);
  final String text;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 8, top: 4),
      child: Align(
        alignment: Alignment.centerLeft,
        child: Text(
          text,
          style: theme.textTheme.bodyMedium?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
      ),
    );
  }
}

class _ColorDot extends StatelessWidget {
  const _ColorDot({
    required this.color,
    required this.selected,
    required this.onTap,
  });
  final Color color;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: 36,
        height: 36,
        decoration: BoxDecoration(
          color: color,
          shape: BoxShape.circle,
          border: Border.all(
            color: selected
                ? Theme.of(context).colorScheme.primary
                : Theme.of(context).colorScheme.outlineVariant,
            width: selected ? 3 : 1,
          ),
        ),
        child: selected
            ? Icon(
                Icons.check_rounded,
                size: 18,
                color: color.computeLuminance() > 0.5
                    ? Colors.black
                    : Colors.white,
              )
            : null,
      ),
    );
  }
}
