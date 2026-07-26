# Reelio AI — backend (Gemini)

Небольшой безопасный сервис, который принимает монтажный запрос от клиента,
вызывает **Gemini** и возвращает строго типизированный JSON-план монтажа.

> Настоящий MP4 собирает отдельный **FFmpeg render worker** (в этом репозитории
> ещё не реализован). Gemini создаёт только план, а не видео.

## Почему отдельный backend

GitHub Pages — статический хостинг и не может безопасно хранить секреты.
`GEMINI_API_KEY` живёт **только** здесь, в переменной окружения сервера, и
никогда не попадает в Flutter/JS/`main.dart.js`/GitHub Pages.

## Локальный запуск

```bash
cd backend
cp .env.example .env      # впишите GEMINI_API_KEY
npm install
npm start                 # http://localhost:8080
```

Проверка: `curl http://localhost:8080/` → `{"ok":true,...}`.

## Подключение клиента

Соберите Flutter Web с адресом backend'а (ключ в сборку НЕ передаётся):

```bash
flutter build web --release --base-href /reelio-ai-web/ \
  --dart-define=REELIO_BACKEND_URL=https://<ваш-backend>/
```

Без `REELIO_BACKEND_URL` приложение работает в **Demo Mode** (мок-планировщик).

## Хостинг (выберите один и задайте секреты его средствами)

- **Render / Railway / Fly.io / Cloud Run**: задеплойте папку `backend/`,
  переменные окружения `GEMINI_API_KEY` и `ALLOWED_ORIGIN` — через секреты
  платформы, не в коде.
- CORS уже ограничен `https://murbellka.github.io` и локальными адресами
  (см. `server.js` / `ALLOWED_ORIGIN`).

## Безопасность

- Ключ не логируется, не возвращается клиенту и не попадает в тексты ошибок.
- Rate limit: 20 запросов/мин на IP для `/edit-plan`.
- Ответ Gemini валидируется схемой на клиенте перед рендером.
- Пользовательский текст передаётся как данные, а не как инструкции.
