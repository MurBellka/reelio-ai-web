# Подготовка к публикации — чек‑лист владельца

Приложение подготовлено технически, но перед отправкой в App Store и Google Play
владелец должен выполнить действия ниже. Автоматическая отправка и подпись
**не выполнялись** — личные сертификаты не используются.

## Общее

- [ ] Заменить `com.reelio.reelioAi` на собственный уникальный Bundle ID / Application ID.
- [ ] Задать финальные `version` и build‑number в `pubspec.yaml`.
- [ ] Заменить иконку‑заглушку на фирменную (`flutter_launcher_icons` или вручную
      в `ios/Runner/Assets.xcassets` и `android/app/src/main/res/mipmap-*`).
- [ ] Заменить плейсхолдеры privacy policy и support URL в `lib/core/constants.dart`
      (`privacyPolicyUrl`, `supportUrl`) и опубликовать реальные страницы.
- [ ] Убедиться, что тексты интерфейса и описания в сторах не заявляют о настоящем
      AI‑рендеринге, пока используется мок‑логика.

## iOS (App Store)

- [ ] Открыть `ios/Runner.xcworkspace` в Xcode, выбрать Team и настроить подпись
      (Automatic signing / провижининг).
- [ ] Проверить `Info.plist`: описание доступа к галерее уже добавлено
      (`NSPhotoLibraryUsageDescription`, на русском). Лишних разрешений нет.
- [ ] Настроить конфигурации Debug/Release и App Store Connect (метаданные, скриншоты 9:16).
- [ ] Собрать архив: `flutter build ipa` и загрузить через Xcode/Transporter.
- [ ] Минимальная версия iOS определяется требованиями пакетов (image_picker,
      video_player). При необходимости поднять `IPHONEOS_DEPLOYMENT_TARGET` в Podfile/Xcode.

> Примечание. В данном окружении полная iOS‑сборка компилируется, но шаг ad‑hoc
> codesign движкового `Flutter.framework` не проходит из‑за ограничения песочницы
> (codesign отклоняет закешированный артефакт движка). На обычной рабочей машине с
> Xcode подпись выполняется штатно; при повторении ошибки помогает
> `flutter precache --ios --force` (перекачать чистые артефакты движка).

## Android (Google Play)

- [ ] Установить Android SDK (Android Studio) — в текущем окружении он отсутствовал,
      поэтому Android‑сборка здесь не запускалась.
- [ ] Создать upload keystore и настроить `android/key.properties` + `signingConfigs`
      в `android/app/build.gradle.kts` (сейчас release подписан debug‑ключом как заглушка).
- [ ] Проверить `minSdk`/`targetSdk` (наследуются от Flutter; поднять при необходимости).
- [ ] Собрать `flutter build appbundle` и загрузить AAB в Play Console.
- [ ] Заполнить Data safety форму: приложение читает медиа из галереи и **не**
      отправляет пользовательские файлы в сеть.

## Проверка перед релизом

- [ ] `flutter analyze` — без замечаний.
- [ ] `flutter test` — все тесты зелёные.
- [ ] Пройти сквозной сценарий на реальном устройстве (маленький iPhone и крупный Android).
- [ ] Проверить отказ в доступе к галерее, отмену выбора, длинное видео (>10 мин),
      21‑й файл, сворачивание во время обработки и восстановление черновика после перезапуска.
