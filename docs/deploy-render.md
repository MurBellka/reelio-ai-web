# Развёртывание рендера

> **Статус на 2026-07-26: шаги 0–6 ВЫПОЛНЕНЫ** с подтверждения владельца.
> `reelio-backend` работает в cloud mode под `reelio-api@`: revision
> `reelio-backend-00004-fer`, 100% трафика. Выкатывалось поэтапно — сначала
> canary с нулевым трафиком, затем 10%, затем 100%.
>
> Revision `reelio-backend-00001-gxw` **сохранена** для мгновенного отката,
> права её сервисного аккаунта не отзывались.
>
> Порядок важен: IAM должен существовать до деплоя, иначе сервис поднимется с
> избыточными правами.

Проект: `gemini-503615` · регион: `europe-west1` · аккаунт: `kvasizabel509@gmail.com`

## Фактическое состояние (2026-07-26, после шагов 0–5)

| Ресурс | Состояние |
|---|---|
| Cloud Run service `reelio-backend` | ✅ работает, `https://reelio-backend-dgmyl44vdq-ew.a.run.app` |
| Сервисный аккаунт сервиса | ⚠️ всё ещё `794100432449-compute@…` (**дефолтный, Editor**) — меняется шагом 6 |
| Cloud Run Job `reelio-ffmpeg-worker` | ✅ развёрнут под `reelio-worker@`, 4 vCPU / 8 GiB / 30 мин |
| Бакет `reelio-render-eu` | ✅ europe-west1, UBLA, public access prevention = enforced |
| Firestore (Native, eur3) | ✅ создан |
| `reelio-api@` / `reelio-worker@` | ✅ созданы, права по минимуму |
| Секрет `reelio-worker-token` | ✅ в Secret Manager, доступ обоим SA |

Сервис по-прежнему в **local mode** (`health.render.mode = "local"`) и облачных
задач не запускает: пока не выполнен шаг 6, созданная инфраструктура просто
стоит наготове.

**Проверено настоящим рендером в облаке** (Job запускался напрямую, в обход
сервиса): plan.json из `gs://` → MP4 в `gs://`. ffprobe подтвердил
`h264/aac 48 kHz stereo`, кадр `720×1280` и `1080×1920`, длительность 8.000s.
Тестовые артефакты удалены, бакет пуст.

## Оценка расходов

| Ресурс | Модель оплаты | Порядок при демо-нагрузке |
|---|---|---|
| Cloud Storage (Standard, europe-west1) | ~$0.023/ГБ·мес + исходящий трафик | центы; lifecycle чистит через 7/30 дней |
| Firestore (Native) | бесплатный лимит 50k чтений / 20k записей в день | внутри бесплатного лимита |
| Cloud Run Job (worker) | vCPU·с и ГиБ·с только во время рендера | зависит от длины роликов; 4 vCPU × ~2 мин ≈ центы за ролик |
| Cloud Run Service | уже развёрнут | без изменений |

Главный рычаг стоимости — рендер. Идемпотентность `/render` и лимит в 2 активные
задачи на проект уже режут повторные запуски.

---

## Шаг 0. Включить API

```bash
gcloud services enable firestore.googleapis.com run.googleapis.com \
  storage.googleapis.com artifactregistry.googleapis.com \
  cloudbuild.googleapis.com iamcredentials.googleapis.com \
  --project gemini-503615
```

`iamcredentials.googleapis.com` обязателен: без него не работает `signBlob`,
то есть подписанные ссылки на скачивание.

## Шаг 1. Firestore (Native mode)

```bash
gcloud firestore databases create --location=eur3 --type=firestore-native \
  --project gemini-503615
```

> Режим базы меняется только пересозданием — выбираем Native сразу.

TTL-политика на автоочистку завершённых задач:

```bash
gcloud firestore fields ttls update expiresAt \
  --collection-group=renderJobs --enable-ttl --project gemini-503615
```

## Шаг 2. Бакет рендера

```bash
BUCKET=reelio-render-eu

gcloud storage buckets create "gs://${BUCKET}" \
  --project gemini-503615 --location europe-west1 \
  --uniform-bucket-level-access --public-access-prevention
```

Lifecycle (backstop к §6):

```bash
cat > /tmp/lifecycle.json <<'JSON'
{ "rule": [
  { "action": {"type": "Delete"},
    "condition": {"age": 30, "matchesPrefix": ["projects/"]} }
]}
JSON
gcloud storage buckets update "gs://${BUCKET}" --lifecycle-file=/tmp/lifecycle.json
```

> Раздельные TTL из §6 (1 день на `tmp/`, 7 на `jobs/`, 30 на `sources/`) через
> lifecycle **невыразимы**: `matchesPrefix` принимает только буквальный префикс,
> а `projectId` в пути переменный — шаблона `projects/*/jobs/*/tmp/` не бывает.
> Поэтому lifecycle оставлен грубым предохранителем на 30 дней, а настоящий
> срок жизни результата задаёт `expiresAt` в Firestore: backend отдаёт
> `410 RESULT_EXPIRED` через 7 дней, даже если файл ещё физически лежит.
> Рабочие файлы `tmp/` убирает за собой сам worker.

CORS — чтение результата и **прямая загрузка исходников** (§8.2). Без `PUT`
браузер не сможет отправить байты в бакет:

```bash
cat > /tmp/cors.json <<'JSON'
[{ "origin": ["https://murbellka.github.io", "http://localhost:5353"],
   "method": ["GET", "HEAD", "PUT"],
   "responseHeader": ["Content-Type", "Content-Disposition", "Content-Length"],
   "maxAgeSeconds": 3600 }]
JSON
gcloud storage buckets update "gs://${BUCKET}" --cors-file=/tmp/cors.json
```

## Шаг 3. Сервисные аккаунты и минимальные права

Двa аккаунта вместо дефолтного Editor'а (контракт §9).

```bash
P=gemini-503615
BUCKET=reelio-render-eu
API_SA="reelio-api@${P}.iam.gserviceaccount.com"
WORKER_SA="reelio-worker@${P}.iam.gserviceaccount.com"

gcloud iam service-accounts create reelio-api    --project "$P" \
  --display-name "Reelio backend API"
gcloud iam service-accounts create reelio-worker --project "$P" \
  --display-name "Reelio FFmpeg worker"
```

**API-аккаунт** — Firestore, объекты бакета, запуск и отмена Job, подпись URL:

```bash
gcloud projects add-iam-policy-binding "$P" \
  --member "serviceAccount:${API_SA}" --role roles/datastore.user

gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member "serviceAccount:${API_SA}" --role roles/storage.objectAdmin

# Подпись V4 URL без скачивания ключа: право подписать самому себе.
gcloud iam service-accounts add-iam-policy-binding "$API_SA" --project "$P" \
  --member "serviceAccount:${API_SA}" \
  --role roles/iam.serviceAccountTokenCreator
```

**Worker-аккаунт** — только объекты бакета. Доступа к Firestore нет: прогресс
идёт через `/internal/jobs/{id}/progress` (§8.1).

```bash
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member "serviceAccount:${WORKER_SA}" --role roles/storage.objectAdmin
```

Право API-аккаунта запускать и отменять именно этот Job (после шага 4):

```bash
gcloud run jobs add-iam-policy-binding reelio-ffmpeg-worker \
  --project "$P" --region europe-west1 \
  --member "serviceAccount:${API_SA}" --role roles/run.invoker

gcloud iam service-accounts add-iam-policy-binding "$WORKER_SA" --project "$P" \
  --member "serviceAccount:${API_SA}" --role roles/iam.serviceAccountUser
```

Запрещено и не используется: `roles/owner`, `roles/editor`, JSON-ключи SA,
`allUsers` в IAM бакета, публичный доступ к объектам.

## Шаг 4. Секрет worker'а

```bash
openssl rand -hex 32 | gcloud secrets create reelio-worker-token \
  --project "$P" --data-file=- --replication-policy=automatic

for SA in "$API_SA" "$WORKER_SA"; do
  gcloud secrets add-iam-policy-binding reelio-worker-token --project "$P" \
    --member "serviceAccount:${SA}" --role roles/secretmanager.secretAccessor
done
```

Значение секрета не печатается и в репозиторий не попадает.

## Шаг 5. Cloud Run Job (FFmpeg worker)

> Выполняется **после** объединения ветки `worktree-ffmpeg-worker` — нужен
> `backend/worker/Dockerfile`.

```bash
gcloud run jobs deploy reelio-ffmpeg-worker \
  --project "$P" --region europe-west1 \
  --source backend/worker/ \
  --service-account "$WORKER_SA" \
  --cpu 4 --memory 8Gi --task-timeout 15m --max-retries 0 --tasks 1 \
  --set-secrets REELIO_WORKER_TOKEN=reelio-worker-token:latest
```

Остальные переменные (`REELIO_JOB_ID`, `REELIO_PLAN_URI`, …) backend передаёт на
каждый запуск через overrides — задавать их в описании Job'а не нужно.

Параметры выбраны как ограничитель расходов публичной беты: одна задача,
**без повторов** (неудачный рендер не должен молча стоить второй запуск) и
таймаут 15 минут при потолке ролика в 2 минуты — с запасом на 4K, но без
возможности крутиться полчаса.

Схему путей worker больше не конструирует: он получает `REELIO_PROJECT_PREFIX`
и `REELIO_JOB_PREFIX` от backend'а, где в них зашит проверенный uid владельца.
Если переменных нет, worker откатывается на старую схему `projects/{id}/` —
благодаря этому его можно обновлять независимо от backend'а.

## Шаг 6. Переключение backend'а в cloud mode

```bash
# Адрес берётся из сервиса, а не пишется руками — см. §PUBLIC_BASE_URL ниже.
STATUS_URL=$(gcloud run services describe reelio-backend \
  --project "$P" --region europe-west1 --format="value(status.url)")

gcloud run services update reelio-backend --project "$P" --region europe-west1 \
  --service-account "$API_SA" \
  --set-env-vars "RENDER_BUCKET=${BUCKET},RENDER_JOB_NAME=reelio-ffmpeg-worker,RENDER_JOB_REGION=europe-west1,GOOGLE_CLOUD_PROJECT=${P},PUBLIC_BASE_URL=${STATUS_URL}" \
  --update-secrets "REELIO_WORKER_TOKEN=reelio-worker-token:latest"
```

Смена сервисного аккаунта — момент повышенного риска: у нового SA нет прав на
`GEMINI_API_KEY`. Выдать до переключения:

```bash
gcloud secrets add-iam-policy-binding <имя-секрета-gemini> --project "$P" \
  --member "serviceAccount:${API_SA}" --role roles/secretmanager.secretAccessor
```

## Шаг 6б. Canary-проверка (выполнена)

Перед переключением трафика cloud-mode разворачивается отдельной revision с
тегом `canary` и **нулевым трафиком**:

```bash
gcloud run deploy reelio-backend --project "$P" --region europe-west1 \
  --source backend/ --no-traffic --tag canary \
  --service-account "$API_SA" \
  --set-env-vars "…,PUBLIC_BASE_URL=https://canary---reelio-backend-dgmyl44vdq-ew.a.run.app" \
  --set-secrets "GEMINI_API_KEY=GEMINI_API_KEY:latest,WORKER_TOKEN=reelio-worker-token:latest"
```

`PUBLIC_BASE_URL` обязан указывать на **canary-адрес**, иначе worker будет
отчитываться о прогрессе в production-revision, которая про эти задачи не знает.

Переключение трафика — отдельный шаг, требующий подтверждения владельца.

### `PUBLIC_BASE_URL` — только постоянный URL сервиса (долг закрыт)

`PUBLIC_BASE_URL` обязан равняться **`status.url`** сервиса, а не адресу тега:

```bash
STATUS_URL=$(gcloud run services describe reelio-backend \
  --project "$P" --region europe-west1 --format="value(status.url)")
```

Адрес тега (`https://canary---…run.app`) сюда прописывать **нельзя**: тег живёт
ровно до уборки после выката, а его удаление тихо ломает рендер — worker теряет
адрес для отчётов, задачи виснут в `queued` и падают в `WORKER_TIMEOUT`. Это тот
же класс отказа, что и хвостовой `\n` в секрете: конвейер «работает», но
результат до пользователя не доходит.

Исключение — момент выката со сплитом трафика. Пока часть трафика идёт на старую
revision, отчёты worker'а обязаны идти по адресу тега новой revision, иначе часть
из них попадёт в revision, которая про эти задачи не знает. Порядок такой:

1. canary с нулевым трафиком и `PUBLIC_BASE_URL` = адрес тега — проверка;
2. сплит трафика — проверка совместимости старых маршрутов;
3. 100% на новую revision;
4. **сразу после** — новая revision с `PUBLIC_BASE_URL` = `status.url`, проверка
   через её тег, затем 100% на неё;
5. только теперь можно снимать теги.

Проверка, что всё сошлось: в логах отчёты worker'а идут на адрес **без**
префикса тега.

```bash
gcloud logging read 'httpRequest.requestUrl:"/internal/jobs/"' \
  --project "$P" --freshness=15m --format="value(httpRequest.requestUrl)" \
  | sed -E 's#(https://[^/]+)/internal.*#\1#' | sort | uniq -c
```

### Про поэтапный выкат: важное ограничение

Старая revision не знает маршрутов рендера (`/uploads`, `/render`, `/jobs/*`),
поэтому сплит трафика **не является плавным выкатом** для них: каждый запрос —
отдельный бросок монеты, и на стадии 10% путь рендера рвётся на поллинге. При
проверке 90/10 в логах это выглядело как 23 честных 404 от `00001-gxw`.

Вывод на будущее: стадия со сплитом полезна как проверка «не сломалось ли
старое» (`/health`, `/edit-plan` живут в обеих revision), но полный сценарий
рендера имеет смысл проверять либо по canary-адресу, либо уже после 100%.

## Шаг 7. Проверка после деплоя

```bash
curl -s https://reelio-backend-dgmyl44vdq-ew.a.run.app/health | jq .
# ожидается: {"render":{"configured":true,"mode":"cloud"}, "contractVersion":1, …}
```

Затем — настоящий ролик в 720p и 1080p (см. `scripts/e2e-render.sh`, тот же
сценарий против облачного URL) и проверка ffprobe'ом: `h264`/`aac`,
`720×1280` и `1080×1920`.

## Откат

```bash
gcloud run services update reelio-backend --project "$P" --region europe-west1 \
  --remove-env-vars RENDER_BUCKET,RENDER_JOB_NAME
```

Сервис вернётся в local mode: `/edit-plan` продолжит работать, рендер-эндпоинты
перестанут запускать облачные задачи. Данные при этом не удаляются.
