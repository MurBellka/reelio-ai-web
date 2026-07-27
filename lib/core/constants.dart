/// Централизованные ограничения продукта.
///
/// Эти лимиты дублируются в UI и в мок-логике сервисов, но единственным
/// источником истины для проверки остаётся [MediaLimits].
class AppConstants {
  const AppConstants._();

  static const String appName = 'Reelio AI';

  /// Максимум видео в одном проекте.
  static const int maxVideos = 20;

  /// Максимум фотографий в одном проекте.
  static const int maxPhotos = 20;

  /// Максимальная длительность одного видео — 10 минут.
  static const Duration maxSingleVideo = Duration(minutes: 10);

  /// Максимальная длительность итогового ролика — 2 минуты.
  static const int maxOutputSeconds = 120;

  /// Геометрия итогового ролика (вертикаль 9:16).
  static const int outputWidth = 1080;
  static const int outputHeight = 1920;
  static const String outputAspectRatio = '9:16';

  /// Поддерживаемые расширения (регистр не важен — сравнение всегда идёт
  /// по расширению в нижнем регистре, см. [MediaLimits.extensionOf]).
  static const List<String> supportedVideoExtensions = <String>[
    'mp4',
    'mov',
    'm4v',
    'webm',
    'avi',
    'mkv',
    'mpeg',
    'mpg',
    '3gp',
  ];
  static const List<String> supportedImageExtensions = <String>[
    'jpg',
    'jpeg',
    'png',
    'webp',
    'heic',
    'heif',
    'gif',
    'bmp',
    'tiff',
  ];

  /// Форматы, которые нельзя надёжно декодировать в браузере или во
  /// встроенном плеере на клиенте (нет кодека/контейнера в HTML5 <video>,
  /// или формат изображения не поддерживается тегом <img>).
  ///
  /// Клиент такие файлы всё равно принимает — они лишь получают
  /// карточку-заглушку вместо превью (см. `UnsupportedPreviewPlaceholder`).
  /// Финальную перекодировку в совместимый формат должен выполнять backend
  /// через FFmpeg перед обработкой проекта — см. `ServerTranscodeService`.
  static const List<String> serverTranscodeExtensions = <String>[
    'avi',
    'mkv',
    'mpeg',
    'mpg',
    '3gp',
    'heic',
    'heif',
    'tiff',
  ];

  /// Доступные длительности итогового ролика (в секундах).
  static const List<int> durationOptions = <int>[15, 30, 60, 90, 120];

  /// Ключ хранения черновика проекта.
  static const String draftStorageKey = 'reelio_project_draft_v1';

  /// Ключ хранения активной задачи рендера — по нему сценарий восстанавливается
  /// после перезагрузки страницы.
  static const String activeRenderJobKey = 'reelio_active_render_job_v1';

  /// Публичный контакт поддержки. Один адрес на всё: вопросы, жалобы и
  /// запросы на удаление данных — пользователю не нужно гадать, куда писать.
  static const String supportEmail = 'reelio.support.app@gmail.com';

  /// Готовая ссылка для кнопки «Написать в поддержку».
  static String supportMailto({String subject = 'Reelio AI'}) =>
      'mailto:$supportEmail?subject=${Uri.encodeComponent(subject)}';
}
