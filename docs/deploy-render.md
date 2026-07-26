# Развёртывание рендера — план (НЕ ВЫПОЛНЕН)

> **Ни одна команда из этого документа не запускалась.** Всё ниже создаёт
> платные ресурсы или меняет IAM и требует явного подтверждения владельца.
> Порядок важен: IAM должен существовать до деплоя, иначе сервис поднимется с
> избыточными правами.

Проект: `gemini-503615` · регион: `europe-west1` · аккаунт: `kvasizabel509@gmail.com`

## Что есть сейчас (проверено read-only 2026-07-26)

| Ресурс | Состояние |
|---|---|
| Cloud Run service `reelio-backend` | ✅ работает, `https://reelio-backend-dgmyl44vdq-ew.a.run.app` |
| Сервисный аккаунт сервиса | ⚠️ `794100432449-compute@…` — **дефолтный, с ролью Editor** |
| Cloud Run Job (worker) | ❌ нет |
| Бакет рендера | ❌ нет (есть только служебный `run-sources-…`) |
| Firestore | ❌ API не включён |
| `reelio-api@` / `reelio-worker@` | ❌ нет |

Пока этого нет, backend работает в **local mode** и рендер-эндпоинты отвечают
честно (`health.render.mode = "local"`). Ломаться нечему.

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

Lifecycle по контракту §6:

```bash
cat > /tmp/lifecycle.json <<'JSON'
{ "rule": [
  { "action": {"type": "Delete"},
    "condition": {"age": 1, "matchesPrefix": ["projects/"], "matchesSuffix": ["/tmp/"]} },
  { "action": {"type": "Delete"},
    "condition": {"age": 7, "matchesPrefix": ["projects/"]} },
  { "action": {"type": "Delete"},
    "condition": {"age": 30} }
]}
JSON
gcloud storage buckets update "gs://${BUCKET}" --lifecycle-file=/tmp/lifecycle.json
```

CORS — только на чтение результата из браузера:

```bash
cat > /tmp/cors.json <<'JSON'
[{ "origin": ["https://murbellka.github.io"],
   "method": ["GET", "HEAD"],
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
  --cpu 4 --memory 8Gi --task-timeout 30m --max-retries 1 \
  --set-secrets REELIO_WORKER_TOKEN=reelio-worker-token:latest
```

Остальные переменные (`REELIO_JOB_ID`, `REELIO_PLAN_URI`, …) backend передаёт на
каждый запуск через overrides — задавать их в описании Job'а не нужно.

## Шаг 6. Переключение backend'а в cloud mode

```bash
gcloud run services update reelio-backend --project "$P" --region europe-west1 \
  --service-account "$API_SA" \
  --set-env-vars "RENDER_BUCKET=${BUCKET},RENDER_JOB_NAME=reelio-ffmpeg-worker,RENDER_JOB_REGION=europe-west1,GOOGLE_CLOUD_PROJECT=${P},PUBLIC_BASE_URL=https://reelio-backend-dgmyl44vdq-ew.a.run.app" \
  --update-secrets "REELIO_WORKER_TOKEN=reelio-worker-token:latest"
```

Смена сервисного аккаунта — момент повышенного риска: у нового SA нет прав на
`GEMINI_API_KEY`. Выдать до переключения:

```bash
gcloud secrets add-iam-policy-binding <имя-секрета-gemini> --project "$P" \
  --member "serviceAccount:${API_SA}" --role roles/secretmanager.secretAccessor
```

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
