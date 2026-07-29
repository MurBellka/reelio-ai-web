# Развёртывание beta v2 (contract v2)

> **Статус: реализованы и протестированы итерации 4A, 4B, 4C** (deployable
> beta backend + долговечное выполнение + полный render API v2 + подключение
> Flutter через feature flag), а также локальная/CI-часть 4D (fakes, emulator
> -gated тесты, контейнерные проверки). **Настоящий облачный e2e** (реальные
> Cloud Tasks, Cloud Run Jobs, Firestore, IAM) — ОТДЕЛЬНЫЙ этап после нового
> независимого review и разрешения владельца; здесь облачные ресурсы не
> создаются и не изменяются. Production v1 (`reelio-backend`,
> `reelio-ffmpeg-worker`) НЕ затрагивается.

Проект `gemini-503615` · регион `europe-west1`.

## Безопасность на уровне архитектуры

Публичный Cloud Run API (`reelio-backend-beta`) **доступен браузеру** — это
нормально для SPA: сам по себе доступ к сети ничего не даёт. Защищён КАЖДЫЙ
пользовательский маршрут:

- **Firebase Auth** (`Authorization: Bearer <idToken>`) — `verifyIdToken`
  с `checkRevoked`; без валидной сессии — `401`.
- **App Check** (`X-Firebase-AppCheck`) — независимый middleware; режим
  по умолчанию `monitor` (проверяет и логирует, не блокирует), переключается
  в `enforce` переменной `APP_CHECK_MODE`.
- **Изоляция по uid** — путь каждого объекта обязан лежать под
  `users/{uid}/projects/{projectId}/`; чужой путь отвергается до хранилища.
- `/health` — единственный публичный маршрут без токена (его дёргает Cloud
  Run/health-check). Отдаёт `apiVersion: 2`, `renderContractVersion: 2`,
  `authRequired: true`, имя сервиса — чтобы бету нельзя было спутать с prod.
- **Внутренний** `/internal/analysis/run` — только Cloud Tasks с OIDC-токеном
  от invoker-SA; без валидного OIDC закрыт.

**Публичные объекты Storage запрещены.** Бакет создаётся с
`--uniform-bucket-level-access --public-access-prevention`; `allUsers` в IAM
не выдаётся; доступ к байтам — только по короткоживущим signed URL (upload и
download), которые подписывает API-SA.

## Ресурсы

| Ресурс | Назначение | Заметки |
|---|---|---|
| Cloud Run service `reelio-backend-beta` | API contract v2 (analysis + render) | образ `backend/beta/Dockerfile` (Node 22 + ffmpeg/ffprobe, nonroot, tini, HEALTHCHECK) |
| Firestore (Native, eur3) | анализы, квоты, идемпотентность, render jobs | **обязателен**: в cloud mode MemoryStore запрещён (сервис не стартует) |
| Cloud Tasks queue (europe-west1) | долговечный запуск анализа/рендера | заменяет fire-and-forget; НЕ `min-instances=1` |
| Cloud Storage bucket (v2) | медиа `users/{uid}/…` и результаты рендера | UBLA + public-access-prevention; CORS для Pages-origin; signed URL |
| Cloud Run Job `reelio-ffmpeg-worker-v2` | рендер MP4 по EditPlan v2 | образ `backend/worker-v2/Dockerfile`; запускается ТОЛЬКО им (4B) |
| Secret `GEMINI_API_KEY` | ключ модели (переиспользуется) | только из env/Secret Manager, в клиент/сборку не попадает |
| Secret `reelio-worker-token` | канал прогресса worker↔backend (переиспользуется) | `trim()` от хвостового `\n` |

Firestore-индекс (композитный), нужен `countActive*`:
`beta_jobs (uid ASC, terminal ASC)` и `beta_render_jobs (uid ASC, terminal ASC)`.

## Service accounts и минимальные IAM-роли

- **`reelio-api-beta@`** (сервис):
  `roles/datastore.user` (Firestore),
  `roles/storage.objectAdmin` на v2-бакете,
  `roles/iam.serviceAccountTokenCreator` на себе (подпись signed URL без ключа),
  `roles/cloudtasks.enqueuer` (ставить задачи),
  `roles/iam.serviceAccountUser` на invoker-SA (OIDC для задач),
  `roles/run.invoker` + `roles/iam.serviceAccountUser` на Job `worker-v2` (запуск),
  роль `firebaseauth.admin` (для `verifyIdToken(checkRevoked)`).
- **`reelio-tasks-invoker@`** (OIDC для Cloud Tasks): без проектных ролей;
  используется только как `oidcToken.serviceAccountEmail`, а внутренний endpoint
  проверяет `email == invoker-SA`.
- **`reelio-worker-v2@`** (Job): только `roles/storage.objectAdmin` на v2-бакете.

Запрещено: `roles/owner`/`editor`, JSON-ключи SA, `allUsers`, публичные объекты.

## Переменные окружения (несекретные)

Сервис: `REELIO_RUNTIME=cloud`, `GOOGLE_CLOUD_PROJECT`/`FIREBASE_PROJECT_ID`,
`REELIO_STORE=firestore`, `APP_CHECK_MODE=monitor`, `BETA_ALLOWED_ORIGINS`,
`REELIO_RENDER_BUCKET`, `CLOUD_TASKS_QUEUE`, `CLOUD_TASKS_LOCATION`,
`INTERNAL_BASE_URL` (= URL самого сервиса), `TASKS_INVOKER_SA`,
`RENDER_JOB_NAME_V2=reelio-ffmpeg-worker-v2`, `RENDER_JOB_REGION`,
`PUBLIC_BASE_URL`, `SIGNED_URL_TTL_SECONDS`, `RENDER_RESULT_TTL_DAYS`.
Секреты (`--set-secrets`): `GEMINI_API_KEY`, `REELIO_WORKER_TOKEN`.

Flutter (build-time, несекретные, §4C): `REELIO_BETA_BACKEND_URL`,
`REELIO_V2_ENABLED` (по умолчанию `false`). Ключ Gemini во Flutter/GitHub-сборку
НИКОГДА не передаётся.

## Стоимость и лимиты

- Cloud Run service: масштаб от нуля; **max-instances низкий** (Firestore
  делает состояние общим, но всё равно ограничиваем расход). Долговечность
  даёт Cloud Tasks, а не `min-instances`.
- Cloud Tasks: `maxAttempts` очереди согласован с `maxAttempts` обработчика
  (по умолчанию 3) — исчерпание повторов даёт безопасный терминальный `failed`.
- Worker-v2 Job: 4 vCPU / 8 GiB / task-timeout 15m / max-retries 0 / tasks 1
  (как v1, ограничитель расхода).
- Анализ (§9/§11): 20 анализов/сутки на пользователя, 8 на проект; ≤80 кадров и
  ≤600 c аудио на проект; ≤60 вызовов Gemini/проект; денежные потолки
  $0.5/проект, $2/сутки на пользователя. Рендер: короткоживущие signed URL,
  `expiresAt` (7 дней) + lifecycle-предохранитель.

## Откат

- Сервис: держать предыдущую revision; `gcloud run services update-traffic
  reelio-backend-beta --to-revisions <prev>=100`. Beta отдельна от prod —
  откат бету не трогает `reelio-backend`.
- Worker-v2 Job: предыдущая revision Job сохраняется; prod Job `reelio-ffmpeg
  -worker` не изменяется.
- Данные: Firestore и бакет при откате сервиса не чистятся; `expiresAt` и
  lifecycle убирают артефакты по сроку.
- Flutter/Pages: cutover идёт последним; откат = revert merge / предыдущий
  `main`-коммит, восстановить repo variable.

## Сделано (4A–4C) и проверено тестами

- **4B** — маршруты `/uploads`, `/render`, `/jobs/{id}`, `/jobs/{id}/cancel`,
  `/download` + внутренний `/internal/render/progress`. Signed uploads по
  серверным путям, проверка ownership, Firestore-статус render jobs, запуск
  ТОЛЬКО `reelio-ffmpeg-worker-v2`, аутентифицированный callback прогресса,
  короткоживущая ссылка, отмена/expiresAt/410. EditPlan v2 в worker v1 не
  уходит. (beta unit-тесты на фейках адаптеров.)
- **4C** — Flutter: `REELIO_BETA_BACKEND_URL` + `REELIO_V2_ENABLED` (по
  умолчанию false), `AnalysisApiClient` и `BetaAiEditingService`, свежие
  Auth+App Check токены на запрос, маршрутизация всех клиентов на активный
  адрес (без смешивания), блокировка загрузки без beta URL, `deploy.yml`
  только с несекретными repo variables. Веб-сборка проходит и в v1, и в v2.

## Осталось — отдельный этап после review и разрешения владельца

- **Настоящий облачный/сквозной e2e**: поднять Firestore emulator и прогнать
  `test/e2e/firestore-store.test.js`; собрать образы `reelio-backend-beta` и
  `reelio-ffmpeg-worker-v2`; сквозной прогон
  upload→analysis→EditPlan v2→worker-v2→MP4→download на реальных/эмулированных
  ресурсах. Пиксельные проверки MP4 (переход, русский TextOverlay,
  оригинальный звук; отсутствие аудиопотока при `keepOriginal=false`) уже
  живут в наборе worker-v2 и контейнерных проверках v2-verify.
- **Координация двойной загрузки**: сейчас beta-планировщик грузит материалы
  для анализа, а рендер грузит их снова (перезапись в бакете безвредна) —
  оптимизация: переиспользовать objectPaths анализа в рендере.
- **Глубокая пересборка экранов processing→preview→export** под порядок
  v2 (upload раньше планирования) вместо текущего сведения загрузки внутрь
  `createEditPlan`.

См. также [[reelio-reels-editor-v2]], `docs/render-contract-v2.md`,
`docs/deploy-render.md` (v1).
