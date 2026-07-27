// Клиентская конфигурация Firebase.
//
// ВСЕ значения здесь ПУБЛИЧНЫЕ по определению: Firebase отдаёт их любому
// браузеру, открывшему приложение. Это не секреты и не заменяют защиту —
// доступ ограничивают правила Firebase Auth, App Check и проверки backend'а.
//
// Серверные секреты (GEMINI_API_KEY, токен worker'а) живут ТОЛЬКО в Secret
// Manager и в этот файл не попадают ни при каких условиях.

import 'package:firebase_core/firebase_core.dart';

class DefaultFirebaseOptions {
  const DefaultFirebaseOptions._();

  static const FirebaseOptions web = FirebaseOptions(
    apiKey: 'AIzaSyDY-ytHu_2glYjXy9gLj3aG-KDnjNSBhnE',
    appId: '1:794100432449:web:cca3ad5afe3289d3dc90c0',
    messagingSenderId: '794100432449',
    projectId: 'gemini-503615',
    authDomain: 'gemini-503615.firebaseapp.com',
    storageBucket: 'gemini-503615.firebasestorage.app',
  );

  /// Публичный ключ reCAPTCHA Enterprise для App Check на Web.
  static const String recaptchaSiteKey =
      '6Ldi6GYtAAAAAIdI3g8vwvWjk8wSj3UhRoE8y6i1';

  /// Пока собран только Web-таргет; мобильные приложения регистрируются
  /// отдельно и получат свои [FirebaseOptions].
  static FirebaseOptions get currentPlatform => web;
}
