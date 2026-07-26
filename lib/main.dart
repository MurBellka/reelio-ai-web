import 'package:firebase_app_check/firebase_app_check.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'app/app.dart';
import 'core/app_config.dart';
import 'core/firebase/firebase_options.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setPreferredOrientations([DeviceOrientation.portraitUp]);

  // Без backend'а приложение работает в демо-режиме: Firebase там не нужен и
  // только мешал бы запуску без сети.
  if (AppConfig.hasBackend) {
    await Firebase.initializeApp(
      options: DefaultFirebaseOptions.currentPlatform,
    );

    // App Check выдаёт клиенту токен «это наше приложение». Backend проверяет
    // его независимо от входа и на этапе выката работает в режиме наблюдения,
    // поэтому сбой активации не должен ронять запуск.
    try {
      await FirebaseAppCheck.instance.activate(
        providerWeb: ReCaptchaEnterpriseProvider(
          DefaultFirebaseOptions.recaptchaSiteKey,
        ),
        // На отладочных сборках настоящий reCAPTCHA недоступен.
        providerAndroid: kDebugMode
            ? const AndroidDebugProvider()
            : const AndroidPlayIntegrityProvider(),
        providerApple: kDebugMode
            ? const AppleDebugProvider()
            : const AppleAppAttestProvider(),
      );
    } catch (_) {
      // Молча продолжаем: запросы уйдут без App Check token, backend в режиме
      // monitor их пропустит и отметит в логе.
    }
  }

  runApp(const ProviderScope(child: ReelioApp()));
}
