# Reelio AI — контракт рендера (v1)

Единый источник истины для трёх участников:

| Участник | Роль | Что читает | Что пишет |
|---|---|---|---|
| **Flutter UI** | клиент | `RenderJob`, `RenderResult` | `RenderRequest` (внутри — `EditPlan`) |
| **Backend API** (Cloud Run Service) | координатор | `RenderRequest` | `RenderJob` в Firestore, запуск Cloud Run Job |
| **FFmpeg worker** (Cloud Run Job) | исполнитель | `plan.json` из Cloud Storage | прогресс в Firestore, MP4 в Cloud Storage |

> **Правило совместимости.** Версия контракта — `render-contract/1`. Любое поле
> можно **добавить** (клиенты обязаны игнорировать неизвестные поля), но нельзя
> переименовать или удалить в рамках мажорной версии. Ломающее изменение = `/v2`
> и новый документ.

Все временные метки — **RFC 3339 UTC** (`2026-07-26T15:04:05.123Z`).
Все длительности — **секунды** (`number`, дробные допустимы).
Все размеры — **байты** (`integer`).

---

## 1. Разрешения экспорта

Ролик всегда вертикальный **9:16**. Апскейл разрешён, но помечается флагом.

| `resolution` | Метка | Ширина × Высота | Видео битрейт (target/max) | Аудио | H.264 level |
|---|---|---|---|---|---|
| `hd720` | 720p | 720 × 1280 | 4 / 5 Мбит/с | AAC 128 kbps | 4.0 |
| `fullHd1080` | 1080p | 1080 × 1920 | 8 / 10 Мбит/с | AAC 160 kbps | 4.2 |
| `twoK1440` | 2K | 1440 × 2560 | 16 / 20 Мбит/с | AAC 192 kbps | 5.0 |
| `fourK2160` | 4K | 2160 × 3840 | 35 / 45 Мбит/с | AAC 192 kbps | 5.1 |
| `maximumAvailable` | Максимальное | вычисляется | по выбранному ряду | — | — |

`maximumAvailable` **резолвится на backend'е** (не на клиенте и не в worker'е):
берётся наибольшее конкретное разрешение, чья высота ≤ максимальной стороны
исходных материалов; если размеры исходников неизвестны — `fullHd1080`.
Результат резолва возвращается в `RenderJob.export` и всегда конкретен.

Общие параметры контейнера (обязательны для worker'а):

```
container : mp4  (+faststart)
video     : h264 (libx264), profile high, yuv420p, GOP = 2 × fps, CRF-off / VBR по таблице
audio     : aac, 48 kHz, stereo
fps       : 30 (по умолчанию) либо 60
scale     : масштаб с сохранением пропорций + pad до точного кадра, без искажений
```

---

## 2. `EditPlan`

Детерминированный монтажный план — **единственный** вход рендера. Формируется
Gemini (`POST /edit-plan`), правится пользователем в UI, отправляется в `/render`
как есть.

```jsonc
{
  "id": "plan_7f3c…",              // string, обязателен
  "prompt": "динамичный ролик о поездке",
  "style": "dynamicStyle",          // dynamicStyle | cinematic | calm | minimal
  "durationSeconds": 30,            // integer, 1..120
  "captions": {
    "enabled": true,
    "language": "ru",               // BCP-47
    "style": "bold",                // clean | bold | karaoke
    "colorHex": "#FFFFFF",          // ^#[0-9A-Fa-f]{6}$
    "sampleText": "Лучшие моменты"
  },
  "music": {
    "track": "chill",               // none | chill | energy | cinematic | trending
    "volume": 0.7                   // 0.0 .. 1.0
  },
  "coverClipId": "clip_1",          // string | null — клип для обложки
  "export": {                       // см. §1; клиент может прислать предпочтение
    "resolution": "maximumAvailable",
    "width": 1080, "height": 1920,
    "fps": 30,
    "estimatedSizeBytes": 37500000,
    "isUpscale": false
  },
  "clips": [
    {
      "id": "clip_1",               // уникален внутри плана
      "mediaId": "asset_a",         // ОБЯЗАТЕЛЕН для рендера: ссылка в assets[]
      "type": "video",              // video | photo
      "duration": 3.5,              // длительность на таймлайне, > 0
      "start": 12.0,                // обрезка внутри исходника (video); null для photo
      "end": 15.5,                  // end > start
      "transition": "crossfade",    // cut | fade | crossfade | slide
      "sourceName": "IMG_0042.mp4", // только для UI
      "reason": "самый динамичный фрагмент",
      "filePath": "/local/…"        // ЛОКАЛЬНЫЙ путь клиента — сервер ИГНОРИРУЕТ
    }
  ]
}
```

**Инварианты (проверяются backend'ом, повторно — worker'ом):**

1. `clips` непусто, ≤ 60 элементов.
2. Каждый `clips[].mediaId` присутствует в `RenderRequest.assets[].id`.
3. Для `type: "video"`: `start ≥ 0`, `end > start`, `end - start ≥ 0.1`.
4. Для `type: "photo"`: `start`/`end` игнорируются, используется `duration`.
5. `Σ clips[].duration ≤ 120` секунд (жёсткий потолок продукта).
6. `music.volume ∈ [0,1]`, `captions.colorHex` — валидный HEX.
7. `filePath` **никогда** не используется сервером — только `mediaId`.

**Audio ducking** (обязателен в worker'е): при наличии речи в исходном видео и
`music.track != "none"` музыка приглушается через `sidechaincompress`
(threshold 0.05, ratio 8, attack 20 мс, release 300 мс) до уровня
`music.volume × 0.35`.

---

## 3. `RenderRequest` → `POST /render`

```jsonc
{
  "contractVersion": 1,
  "projectId": "proj_9d1…",        // string, [A-Za-z0-9_-]{1,64}
  "plan": { /* EditPlan, §2 */ },
  "assets": [
    {
      "id": "asset_a",              // == clips[].mediaId
      "type": "video",              // video | photo
      "objectPath": "projects/proj_9d1/sources/asset_a.mp4", // §6, без gs://
      "sizeBytes": 18234112,
      "durationSeconds": 41.2,      // null для photo
      "width": 1080, "height": 1920,
      "checksumCrc32c": "AAAAAA=="  // опционально, из GCS metadata
    }
  ],
  "export": {                       // опционально; перекрывает plan.export
    "resolution": "fullHd1080",
    "fps": 30
  },
  "idempotencyKey": "…"             // опционально, см. §5
}
```

Заголовки:

```
Content-Type: application/json
Idempotency-Key: <строка ≤ 200 символов>      // альтернатива полю в теле
X-Reelio-Client: flutter/1.4.0 (web|ios|android)
```

Ответ `202 Accepted` (новая задача) или `200 OK` (дубликат, §5) — тело в обоих
случаях `RenderJob` (§4).

---

## 4. `RenderJob` и состояния прогресса

```jsonc
{
  "contractVersion": 1,
  "jobId": "job_01J8…",             // ULID-подобный, стабилен
  "projectId": "proj_9d1…",
  "planId": "plan_7f3c…",
  "status": "running",              // §4.1
  "phase": "encoding",              // §4.2
  "progress": 0.62,                 // 0.0..1.0, монотонно не убывает
  "message": "Кодирование 1080p",   // человекочитаемо, для UI
  "export": {                       // резолвнутый, конкретный
    "resolution": "fullHd1080",
    "width": 1080, "height": 1920, "fps": 30,
    "estimatedSizeBytes": 37500000,
    "isUpscale": false
  },
  "attempt": 1,                     // 1..3
  "createdAt": "2026-07-26T15:04:05.000Z",
  "updatedAt": "2026-07-26T15:05:11.400Z",
  "startedAt": "2026-07-26T15:04:07.100Z",
  "finishedAt": null,
  "expiresAt": "2026-08-02T15:04:05.000Z",  // TTL артефактов, §6
  "result": null,                   // RenderResult при status=succeeded, §4.3
  "error": null,                    // ErrorObject при status=failed, §7
  "cancelRequested": false
}
```

### 4.1 `status` — конечный автомат

```
queued ──► running ──► succeeded        (терминальное)
   │          │
   │          ├──────► failed           (терминальное, retryable в error)
   │          │
   └──────────┴──────► cancelled        (терминальное)
```

| `status` | Значение |
|---|---|
| `queued` | Задача создана, Cloud Run Job запущен или ждёт слот |
| `running` | Worker взял задачу, см. `phase` |
| `succeeded` | MP4 готов, `result` заполнен |
| `failed` | Ошибка, `error` заполнен |
| `cancelled` | Отменено пользователем или системой |

Переходы **только** вперёд по схеме. Терминальный статус неизменяем: попытка
записи в терминальную задачу игнорируется (worker) или даёт `409` (API).

### 4.2 `phase` — этапы прогресса

`phase` уточняет `running`, у каждого этапа фиксированный вклад в `progress`,
чтобы UI показывал ровную полосу без скачков.

| `phase` | `status` | Диапазон `progress` | Описание |
|---|---|---|---|
| `queued` | queued | 0.00 – 0.05 | Ожидание исполнителя |
| `preparing` | running | 0.05 – 0.10 | Валидация плана, резолв разрешения |
| `downloading` | running | 0.10 – 0.30 | Загрузка исходников из Cloud Storage |
| `rendering` | running | 0.30 – 0.60 | Нарезка, переходы, субтитры, ducking |
| `encoding` | running | 0.60 – 0.90 | Кодирование H.264/AAC |
| `uploading` | running | 0.90 – 0.98 | Выгрузка MP4 и обложки |
| `finalizing` | running | 0.98 – 1.00 | Метаданные, signed URL |
| `done` | succeeded | 1.00 | Готово |
| `failed` | failed | — | `progress` замораживается |
| `cancelled` | cancelled | — | `progress` замораживается |

Worker обязан слать heartbeat (обновление `updatedAt`) не реже **чем раз в 30 с**.
Задача без heartbeat дольше **10 минут** считается зависшей: backend переводит её
в `failed` с кодом `WORKER_TIMEOUT` (retryable).

### 4.3 `RenderResult`

```jsonc
{
  "objectPath": "projects/proj_9d1/jobs/job_01J8/output/reel_1080p.mp4",
  "downloadUrl": "https://storage.googleapis.com/…&X-Goog-Signature=…",
  "downloadUrlExpiresAt": "2026-07-26T16:05:11.000Z",  // §8: TTL 60 мин
  "thumbnailObjectPath": "projects/proj_9d1/jobs/job_01J8/output/thumbnail.jpg",
  "thumbnailUrl": "https://storage.googleapis.com/…",
  "sizeBytes": 36120044,
  "durationSeconds": 29.8,
  "width": 1080, "height": 1920, "fps": 30,
  "videoCodec": "h264", "audioCodec": "aac",
  "checksumCrc32c": "l3q19g==",
  "renderedAt": "2026-07-26T15:06:02.000Z"
}
```

---

## 5. Защита от дубликатов (идемпотентность)

Ключ идемпотентности:

```
key = Idempotency-Key header ?? body.idempotencyKey ?? sha256(canonicalJson({projectId, plan, assets, export}))
fingerprint = sha256(projectId + ":" + key)
```

`canonicalJson` — JSON с рекурсивно отсортированными ключами объектов, без
пробелов; поля `clips[].filePath`, `clips[].sourceName`, `clips[].reason`
**исключаются** (они не влияют на пиксели результата).

Правила:

1. Если задача с таким `fingerprint` существует и **не терминальна** → `200 OK`
   с существующим `RenderJob`. Новый Cloud Run Job **не запускается**.
2. Если существует и `succeeded`, а артефакт жив (`expiresAt > now`) → `200 OK`
   с тем же `RenderJob` и **свежим** signed URL.
3. Если существует и `failed`/`cancelled` → создаётся **новая** задача
   (`attempt` наследуется + 1), fingerprint переиспользуется.
4. Разный контент под одним и тем же `Idempotency-Key` → `409`
   `IDEMPOTENCY_KEY_REUSED`.
5. Резервирование fingerprint выполняется **транзакцией** Firestore
   (`create`-only), поэтому две одновременные `/render` дают одну задачу.
6. На проект допускается **не более 2** одновременно активных задач
   (`queued`/`running`), иначе `429 TOO_MANY_ACTIVE_JOBS`.

---

## 6. Cloud Storage — пути объектов

Один бакет `${RENDER_BUCKET}` (регион = регион Cloud Run, uniform bucket-level
access, **публичного доступа нет**).

```
projects/{projectId}/sources/{assetId}.{ext}                     # загруженные исходники
projects/{projectId}/jobs/{jobId}/plan.json                      # снимок EditPlan (вход worker'а)
projects/{projectId}/jobs/{jobId}/output/reel_{height}p.mp4       # результат: reel_1080p.mp4
projects/{projectId}/jobs/{jobId}/output/thumbnail.jpg            # обложка 9:16
projects/{projectId}/jobs/{jobId}/logs/worker.log                 # диагностика (не отдаётся клиенту)
projects/{projectId}/jobs/{jobId}/tmp/…                           # рабочие файлы, удаляются worker'ом
```

Ограничения имён: `projectId`, `jobId`, `assetId` — `^[A-Za-z0-9_-]{1,64}$`.
Любой путь, не начинающийся с `projects/{projectId}/`, отклоняется как
`INVALID_OBJECT_PATH` (защита от path traversal и чужих префиксов).

Lifecycle бакета:

| Префикс | TTL | Правило |
|---|---|---|
| `**/tmp/` | 1 день | автоудаление |
| `**/jobs/**` | 7 дней | автоудаление (`expiresAt` в `RenderJob` совпадает) |
| `**/sources/` | 30 дней | автоудаление |

Метаданные объекта результата: `contentType: video/mp4`,
`cacheControl: private, max-age=0, no-transform`,
`metadata: { jobId, projectId, planId, contractVersion }`.

---

## 7. Формат ошибок

Единый конверт для **всех** не-2xx ответов API:

```jsonc
{
  "error": {
    "code": "PLAN_INVALID",            // стабильный машинный код, SCREAMING_SNAKE
    "message": "Клип clip_3 ссылается на неизвестный mediaId.",  // для человека, ru
    "field": "plan.clips[2].mediaId",  // опционально: путь до проблемного поля
    "retryable": false,                // имеет ли смысл повтор
    "jobId": "job_01J8…",              // если применимо
    "requestId": "req_5f2…"            // для корреляции с логами
  }
}
```

`message` **никогда** не содержит секретов, тел ответов Gemini/GCP, ключей,
подписанных URL и внутренних стектрейсов.

| HTTP | `code` | `retryable` | Когда |
|---|---|---|---|
| 400 | `INVALID_REQUEST` | нет | Тело не JSON / нет обязательных полей |
| 400 | `CONTRACT_VERSION_UNSUPPORTED` | нет | `contractVersion != 1` |
| 400 | `PLAN_INVALID` | нет | Нарушен инвариант §2 |
| 400 | `ASSET_MISSING` | нет | `mediaId` не найден в `assets[]` |
| 400 | `INVALID_OBJECT_PATH` | нет | Путь вне `projects/{projectId}/` |
| 400 | `RESOLUTION_UNSUPPORTED` | нет | Неизвестное `resolution` |
| 400 | `DURATION_EXCEEDED` | нет | Σ длительностей > 120 с |
| 401 | `UNAUTHENTICATED` | нет | Нет/битый токен (когда auth включён) |
| 403 | `FORBIDDEN` | нет | Проект принадлежит другому владельцу |
| 404 | `JOB_NOT_FOUND` | нет | Неизвестный `jobId` |
| 404 | `RESULT_NOT_READY` | да | `/download` до `succeeded` |
| 409 | `IDEMPOTENCY_KEY_REUSED` | нет | Тот же ключ, другой контент |
| 409 | `JOB_ALREADY_TERMINAL` | нет | Отмена завершённой задачи |
| 410 | `RESULT_EXPIRED` | нет | Артефакт удалён по lifecycle |
| 429 | `TOO_MANY_ACTIVE_JOBS` | да | > 2 активных задач на проект |
| 429 | `RATE_LIMITED` | да | Превышен лимит запросов |
| 500 | `INTERNAL` | да | Непредвиденная ошибка |
| 502 | `UPSTREAM_FAILED` | да | Сбой Gemini/GCP API |
| 503 | `RENDER_UNAVAILABLE` | да | Рендер не сконфигурирован (нет бакета/Job) |
| — | `WORKER_TIMEOUT` | да | Нет heartbeat > 10 мин (ставится backend'ом) |
| — | `WORKER_FAILED` | да | FFmpeg вернул ненулевой код |
| — | `SOURCE_UNREADABLE` | нет | Исходник повреждён/не декодируется |
| — | `CANCELLED_BY_USER` | нет | Отмена пользователем |

Коды без HTTP-статуса появляются только внутри `RenderJob.error`.

---

## 8. API endpoints

Базовый URL: `${REELIO_BACKEND_URL}` (Cloud Run Service).
Все ответы — `application/json; charset=utf-8`.

### `GET /health`
`200 {"ok":true,"service":"reelio-backend","contractVersion":1,"render":{"configured":true,"mode":"cloud"}}`

### `POST /edit-plan`
Существующий эндпоинт Gemini. Вход — настройки проекта и манифест материалов,
выход — `{"plan": EditPlan}`. Rate limit 20/мин на IP.

### `POST /render`
Создаёт задачу рендера. Вход — `RenderRequest` (§3).
`202` — новая задача, `200` — идемпотентный дубликат. Тело — `RenderJob`.
Rate limit 10/мин на IP.

### `GET /jobs/{id}`
Текущее состояние. `200` — `RenderJob`; `404 JOB_NOT_FOUND`.
Поддерживает `ETag` / `If-None-Match` → `304` (дешёвый поллинг).
Рекомендуемый интервал поллинга клиента — **2 с**, с backoff до 10 с.
`Cache-Control: no-store`.

### `POST /jobs/{id}/cancel`
Кооперативная отмена. Ставит `cancelRequested: true`, шлёт `cancel` в Cloud Run
Job Execution. `200` — `RenderJob` (`cancelled`, либо ещё `running` до того, как
worker увидит флаг). `409 JOB_ALREADY_TERMINAL` для завершённых.
Идемпотентно: повторная отмена возвращает `200`.

### `GET /download?jobId={id}`
Выдаёт свежий signed URL результата.
`200 { "downloadUrl": "…", "expiresAt": "…", "sizeBytes": …, "fileName": "reelio_1080p.mp4" }`
`404 RESULT_NOT_READY`, `410 RESULT_EXPIRED`.
Опциональный `?redirect=1` → `302 Location: <signed URL>` (удобно для `<a download>`).

### Signed URLs

* V4, метод `GET`, TTL **60 минут** (`expiresAt` всегда возвращается клиенту).
* Подпись — через **IAM `signBlob`** сервисным аккаунтом Cloud Run.
  **Ключи сервисных аккаунтов не скачиваются и не хранятся в репозитории.**
* URL — одноразово-ориентированный: клиент обязан перезапрашивать `/download`,
  а не кэшировать ссылку.
* Signed URL никогда не пишется в логи.

---

## 9. Запуск рендера и IAM

Backend запускает **Cloud Run Job** `${RENDER_JOB_NAME}` через
`run.googleapis.com/v2 …:run` с переопределением переменных окружения:

```
REELIO_JOB_ID, REELIO_PROJECT_ID, REELIO_PLAN_URI (gs://…/plan.json),
REELIO_OUTPUT_PREFIX (projects/{projectId}/jobs/{jobId}/output),
REELIO_BUCKET, REELIO_CONTRACT_VERSION=1
```

`RenderJob.executionName` (внутреннее поле, клиенту не отдаётся) хранит имя
execution для отмены.

Разделение сервисных аккаунтов — минимальные права:

| SA | Роли | Зачем |
|---|---|---|
| `reelio-api@` (Cloud Run Service) | `roles/datastore.user`, `roles/storage.objectAdmin` (на бакет), `roles/run.invoker` + `roles/run.developer` (на Job), `roles/iam.serviceAccountTokenCreator` (на себя) | Firestore, объекты, запуск/отмена Job, подпись URL |
| `reelio-worker@` (Cloud Run Job) | `roles/datastore.user`, `roles/storage.objectAdmin` (на бакет) | Читать исходники, писать результат и прогресс |

Запрещено: `roles/owner`, `roles/editor`, ключи SA в файлах/секретах, публичный
доступ к бакету, `allUsers` в IAM. Аутентификация в GCP — только ADC/Workload
Identity.

---

## 10. Локальный режим (без облака)

Если `RENDER_BUCKET` / `RENDER_JOB_NAME` не заданы, backend поднимается в
**local mode**: состояние задач — в памяти, объекты — в каталоге
`${LOCAL_RENDER_ROOT}` (по умолчанию `.render-local/`) с той же структурой путей
(§6), «signed URL» — локальный `/download` со сроком жизни. Worker запускается
как локальный процесс, если задан `LOCAL_WORKER_CMD`.

Это нужно для end-to-end тестов **без создания платных ресурсов**. Формат
запросов/ответов в local mode идентичен облачному — клиент разницы не видит,
кроме `health.render.mode == "local"`.
