# Образ reelio-backend-beta (Cloud Run service).
#
# Контекст сборки — КОРЕНЬ РЕПОЗИТОРИЯ (нужны только backend/beta):
#   docker build -f backend/beta/Dockerfile -t reelio-backend-beta .
#
# ffmpeg и ffprobe обязательны: beta делает ЛОКАЛЬНЫЙ анализ материала
# (ffprobe → метаданные, ffmpeg → сцены, качество, кадры, аудио) ещё до
# обращения к Gemini. Без них сервис не сможет отобрать кадры для модели.
#
# firebase-admin и @google-cloud/* тянутся npm ci из package-lock: они нужны
# для проверки Firebase Auth/App Check, Firestore-хранилища, Cloud Tasks и
# запуска Cloud Run Job worker-v2. В коде они грузятся динамически, поэтому в
# local mode и в тестах не требуются.

FROM node:22-bookworm-slim

# ffmpeg (с ffprobe), ca-certificates для исходящего TLS, tini для SIGTERM.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg \
      ca-certificates \
      tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Сначала манифесты — слой зависимостей кэшируется отдельно от кода.
COPY backend/beta/package.json backend/beta/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY backend/beta/src/ ./src/

# Проверка окружения до старта: ffprobe и ffmpeg действительно на месте.
RUN ffprobe -version >/dev/null 2>&1 || (echo 'ffprobe отсутствует' && exit 1)
RUN ffmpeg -version >/dev/null 2>&1 || (echo 'ffmpeg отсутствует' && exit 1)

# Непривилегированный пользователь: серверу root не нужен.
RUN useradd --system --uid 10001 --create-home --home-dir /home/beta beta \
 && chown -R beta:beta /app
USER beta

ENV NODE_ENV=production \
    PORT=8080 \
    REELIO_RUNTIME=cloud

EXPOSE 8080

# Контейнерный health-check дёргает публичный /health (без токена и App Check).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "node", "src/index.js"]
