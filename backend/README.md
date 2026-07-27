# Reelio AI — backend

Безопасный сервис с двумя зонами ответственности:

1. **`/edit-plan`** — принимает монтажный запрос, вызывает **Gemini** и
   возвращает строго типизированный JSON-план монтажа.
2. **Координация рендера** — `/render`, `/jobs/{id}`, `/jobs/{id}/cancel`,
   `/download`. Настоящий MP4 собирает отдельный **FFmpeg worker** (Cloud Run
   Job); backend им управляет, но сам ничего не кодирует.

Единый источник истины по форматам — [`docs/render-contract.md`](../docs/render-contract.md).
Менять контракт в одностороннем порядке нельзя: на него опираются worker и
Flutter UI.

## Почему отдельный backend

GitHub Pages — статический хостинг и не может безопасно хранить секреты.
`GEMINI_API_KEY` живёт **только** здесь, в переменной окружения сервера, и
никогда не попадает в Flutter/JS/`main.dart.js`/GitHub Pages.

## Два режима работы

| | `cloud` | `local` |
|---|---|---|
| Включается | заданы `RENDER_BUCKET` и `RENDER_JOB_NAME` | они не заданы |
| Состояние задач | Firestore | память процесса |
| Объекты | Cloud Storage | каталог `LOCAL_RENDER_ROOT` |
| Ссылки | V4 signed URL (IAM signBlob) | локальный `/download/file` с HMAC и TTL |
| Worker | Cloud Run Job execution | процесс из `LOCAL_WORKER_CMD` |

Формат запросов и ответов **идентичен** — клиент разницы не видит, кроме
`GET /health` → `render.mode`. Это позволяет гонять полный end-to-end без
создания платных ресурсов.

## Локальный запуск

```bash
cd backend
cp .env.example .env      # впишите GEMINI_API_KEY (для /edit-plan)
npm install
npm start                 # http://localhost:8080
npm test                  # 67 тестов контракта и API, облако не нужно
```

Проверка: `curl http://localhost:8080/health` →
`{"ok":true,"contractVersion":1,"render":{"mode":"local",…}}`.

## Подключение клиента

```bash
flutter build web --release --base-href /reelio-ai-web/ \
  --dart-define=REELIO_BACKEND_URL=https://<ваш-backend>/
```

Без `REELIO_BACKEND_URL` приложение работает в **Demo Mode** (мок-планировщик).

## Развёртывание (Cloud Run)

Переменные окружения — средствами платформы, никогда не в коде:
`GEMINI_API_KEY`, `ALLOWED_ORIGIN`, `RENDER_BUCKET`, `RENDER_JOB_NAME`,
`RENDER_JOB_REGION`, `PUBLIC_BASE_URL`, `WORKER_TOKEN` (Secret Manager).

Сервисные аккаунты и минимальные роли описаны в контракте, §9. Ключи сервисных
аккаунтов **не скачиваются и не хранятся в репозитории** — только ADC/Workload
Identity.

## Безопасность

- `GEMINI_API_KEY` и `WORKER_TOKEN` не логируются, не возвращаются клиенту и не
  попадают в тексты ошибок; тела ошибок Gemini/GCP наружу не пробрасываются.
- CORS ограничен allowlist'ом; внутренний канал `/internal/*` из браузера
  недоступен и требует Bearer-токен (сравнение постоянное по времени).
- Rate limit: 20/мин `/edit-plan`, 10/мин `/render`, 240/мин поллинг.
- Все пути объектов проверяются на traversal и принадлежность проекту; результат
  worker'а принимается только внутри каталога своей задачи и только если файл
  реально существует — размер и контрольная сумма берутся из хранилища.
- Идемпотентность `/render` защищает от дублирующих запусков (и от лишних
  расходов на рендер) при повторных нажатиях и ретраях сети.
- Подписанные ссылки живут 60 минут и никогда не пишутся в логи.
