import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/router.dart';
import '../../models/enums.dart';
import '../../shared/app_background.dart';
import '../../shared/premium_widgets.dart';
import '../../shared/stage_progress.dart';
import '../../state/providers.dart';

const _promptExample =
    'Сделай динамичный ролик о поездке, начни с вида на море, используй '
    'быстрые склейки и добавь спокойную музыку';

const _promptSuggestions = <String>[
  'Динамичный ролик о путешествии с быстрыми склейками',
  'Спокойный влог одного дня с мягкой музыкой',
  'Яркая нарезка лучших моментов под трендовую музыку',
  'Кинематографичная история заката у моря',
];

const _languages = <(String, String)>[
  ('Русский', 'ru'),
  ('English', 'en'),
  ('Español', 'es'),
];

class EditSettingsScreen extends ConsumerStatefulWidget {
  const EditSettingsScreen({super.key});

  @override
  ConsumerState<EditSettingsScreen> createState() => _EditSettingsScreenState();
}

class _EditSettingsScreenState extends ConsumerState<EditSettingsScreen> {
  late final TextEditingController _promptController;

  @override
  void initState() {
    super.initState();
    _promptController = TextEditingController(
      text: ref.read(projectProvider).prompt,
    );
  }

  @override
  void dispose() {
    _promptController.dispose();
    super.dispose();
  }

  void _create() {
    ref.read(projectProvider.notifier).setStage(AppStage.processing);
    context.push(AppRoutes.processing);
  }

  @override
  Widget build(BuildContext context) {
    final project = ref.watch(projectProvider);
    final controller = ref.read(projectProvider.notifier);
    final theme = Theme.of(context);

    return Scaffold(
      appBar: AppBar(title: const Text('Настройки монтажа')),
      extendBodyBehindAppBar: true,
      body: AppBackground(
        child: SafeArea(
          child: Column(
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 8, 20, 0),
                child: StageProgress(current: AppStage.settings),
              ),
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(20, 16, 20, 16),
                  children: [
                    const SectionHeader(
                      title: 'Опишите ролик',
                      subtitle: 'AI учтёт ваше пожелание при монтаже',
                    ),
                    const SizedBox(height: 12),
                    SoftCard(
                      padding: const EdgeInsets.all(6),
                      child: TextField(
                        controller: _promptController,
                        onChanged: controller.setPrompt,
                        maxLines: 4,
                        minLines: 3,
                        textInputAction: TextInputAction.done,
                        decoration: InputDecoration(
                          border: InputBorder.none,
                          contentPadding: const EdgeInsets.all(14),
                          hintText: _promptExample,
                          hintStyle: TextStyle(
                            color: theme.colorScheme.onSurfaceVariant
                                .withValues(alpha: 0.7),
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(height: 12),
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: [
                        for (final s in _promptSuggestions)
                          ActionChip(
                            label: Text(
                              s.length > 34 ? '${s.substring(0, 34)}…' : s,
                            ),
                            onPressed: () {
                              _promptController.text = s;
                              controller.setPrompt(s);
                            },
                          ),
                      ],
                    ),
                    const SizedBox(height: 28),
                    const SectionHeader(title: 'Стиль'),
                    const SizedBox(height: 12),
                    ...EditStyle.values.map(
                      (style) => Padding(
                        padding: const EdgeInsets.only(bottom: 10),
                        child: SelectableTile(
                          selected: project.style == style,
                          onTap: () => controller.setStyle(style),
                          child: Row(
                            children: [
                              Icon(
                                style.icon,
                                color: theme.colorScheme.primary,
                                size: 26,
                              ),
                              const SizedBox(width: 14),
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(
                                      style.label,
                                      style: theme.textTheme.titleMedium,
                                    ),
                                    Text(
                                      style.description,
                                      style: theme.textTheme.bodySmall
                                          ?.copyWith(
                                            color: theme
                                                .colorScheme
                                                .onSurfaceVariant,
                                          ),
                                    ),
                                  ],
                                ),
                              ),
                              if (project.style == style)
                                Icon(
                                  Icons.check_circle_rounded,
                                  color: theme.colorScheme.primary,
                                ),
                            ],
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(height: 20),
                    const SectionHeader(title: 'Длительность'),
                    const SizedBox(height: 12),
                    _DurationSelector(
                      selected: project.durationSeconds,
                      onSelect: controller.setDuration,
                    ),
                    const SizedBox(height: 24),
                    const SectionHeader(title: 'Субтитры'),
                    const SizedBox(height: 8),
                    SoftCard(
                      child: Column(
                        children: [
                          Row(
                            children: [
                              Expanded(
                                child: Text(
                                  'Показывать субтитры',
                                  style: theme.textTheme.titleMedium,
                                ),
                              ),
                              Switch(
                                value: project.captions.enabled,
                                onChanged: controller.setCaptionsEnabled,
                              ),
                            ],
                          ),
                          if (project.captions.enabled) ...[
                            const Divider(height: 24),
                            Align(
                              alignment: Alignment.centerLeft,
                              child: Text(
                                'Язык субтитров',
                                style: theme.textTheme.bodyMedium?.copyWith(
                                  color: theme.colorScheme.onSurfaceVariant,
                                ),
                              ),
                            ),
                            const SizedBox(height: 8),
                            Wrap(
                              spacing: 8,
                              children: [
                                for (final lang in _languages)
                                  ChoiceChip(
                                    label: Text(lang.$1),
                                    selected:
                                        project.captions.language == lang.$2,
                                    onSelected: (_) =>
                                        controller.setCaptionLanguage(lang.$2),
                                  ),
                              ],
                            ),
                          ],
                        ],
                      ),
                    ),
                    const SizedBox(height: 24),
                    const SectionHeader(title: 'Музыка'),
                    const SizedBox(height: 12),
                    Wrap(
                      spacing: 10,
                      runSpacing: 10,
                      children: [
                        for (final track in MusicTrack.values)
                          _MusicChip(
                            track: track,
                            selected: project.music.track == track,
                            onTap: () => controller.setMusicTrack(track),
                          ),
                      ],
                    ),
                    if (project.music.track.hasAudio) ...[
                      const SizedBox(height: 16),
                      SoftCard(
                        child: Row(
                          children: [
                            Icon(
                              Icons.volume_up_rounded,
                              color: theme.colorScheme.primary,
                            ),
                            Expanded(
                              child: Slider(
                                value: project.music.volume,
                                onChanged: controller.setMusicVolume,
                              ),
                            ),
                            SizedBox(
                              width: 44,
                              child: Text(
                                '${(project.music.volume * 100).round()}%',
                                textAlign: TextAlign.end,
                                style: theme.textTheme.labelLarge,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                    const SizedBox(height: 24),
                    _SummaryCard(),
                  ],
                ),
              ),
              _BottomActions(onCreate: _create),
            ],
          ),
        ),
      ),
    );
  }
}

class _DurationSelector extends StatelessWidget {
  const _DurationSelector({required this.selected, required this.onSelect});
  final int selected;
  final void Function(int) onSelect;

  @override
  Widget build(BuildContext context) {
    const options = [15, 30, 60, 90, 120];
    return Wrap(
      spacing: 10,
      runSpacing: 10,
      children: [
        for (final sec in options)
          ChoiceChip(
            label: Text('$sec сек'),
            selected: selected == sec,
            onSelected: (_) => onSelect(sec),
          ),
      ],
    );
  }
}

class _MusicChip extends StatelessWidget {
  const _MusicChip({
    required this.track,
    required this.selected,
    required this.onTap,
  });
  final MusicTrack track;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return SelectableTile(
      selected: selected,
      onTap: onTap,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            track.icon,
            size: 20,
            color: selected ? scheme.primary : scheme.onSurfaceVariant,
          ),
          const SizedBox(width: 8),
          Text(track.label, style: Theme.of(context).textTheme.titleSmall),
        ],
      ),
    );
  }
}

class _SummaryCard extends ConsumerWidget {
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final p = ref.watch(projectProvider);
    final theme = Theme.of(context);
    final music = p.music.track.hasAudio
        ? '${p.music.track.label} · ${(p.music.volume * 100).round()}%'
        : 'Без музыки';
    return SoftCard(
      color: theme.colorScheme.secondaryContainer,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Резюме', style: theme.textTheme.titleMedium),
          const SizedBox(height: 10),
          _SummaryRow(
            label: 'Материалы',
            value: '${p.videoCount} видео · ${p.photoCount} фото',
          ),
          _SummaryRow(label: 'Стиль', value: p.style.label),
          _SummaryRow(label: 'Длительность', value: '${p.durationSeconds} сек'),
          _SummaryRow(
            label: 'Субтитры',
            value: p.captions.enabled ? 'Вкл · ${p.captions.language}' : 'Выкл',
          ),
          _SummaryRow(label: 'Музыка', value: music),
        ],
      ),
    );
  }
}

class _SummaryRow extends StatelessWidget {
  const _SummaryRow({required this.label, required this.value});
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 110,
            child: Text(
              label,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ),
          Expanded(
            child: Text(
              value,
              style: theme.textTheme.bodyMedium?.copyWith(
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _BottomActions extends StatelessWidget {
  const _BottomActions({required this.onCreate});
  final VoidCallback onCreate;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 8, 20, 12),
      child: Row(
        children: [
          Expanded(
            child: OutlinedButton(
              onPressed: () => Navigator.of(context).maybePop(),
              child: const Text('Назад'),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            flex: 2,
            child: GradientButton(
              label: 'Создать ролик',
              icon: Icons.auto_awesome_rounded,
              onPressed: onCreate,
            ),
          ),
        ],
      ),
    );
  }
}
