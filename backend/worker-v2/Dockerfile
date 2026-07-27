# Образ reelio-ffmpeg-worker-v2 (Cloud Run Job).
#
# ВАЖНО: контекст сборки — КОРЕНЬ РЕПОЗИТОРИЯ, а не каталог worker'а. Образу
# нужны шрифты из assets/fonts/, и это принципиально: §5 контракта требует,
# чтобы web-превью и FFmpeg использовали один и тот же файл шрифта — иначе
# экспорт не совпадёт с тем, что пользователь видел на экране.
#
#   docker build -f backend/worker-v2/Dockerfile -t reelio-ffmpeg-worker-v2 .
#
# Зависимостей npm нет вообще — весь код на стандартной библиотеке Node,
# включая обращения к Cloud Storage через fetch. Поэтому ни `npm ci`, ни
# lock-файла, ни отдельного build-этапа здесь не требуется.
#
# ffmpeg из Debian bookworm (5.1.x) собран с libass, libfreetype и libx264,
# то есть умеет всё, что нужно контракту v2: полный набор режимов xfade,
# zoompan, loudnorm, alimiter и вшивание ASS-субтитров. Минимальная
# поддерживаемая версия — 5.1; более старые сборки не знают части режимов
# xfade, и worker в этом случае откатывается на растворение (§2.2).

FROM node:22-bookworm-slim

# fontconfig нужен libass, чтобы находить шрифты по имени семейства.
# tini — корректная обработка SIGTERM: Cloud Run шлёт его при отмене, и FFmpeg
# должен успеть закрыть файлы (§8.1).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg \
      fontconfig \
      ca-certificates \
      tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/worker-v2/package.json ./
COPY backend/worker-v2/src/ ./src/

# Каталог шрифтов §5 — тот же, что отдаётся web-клиенту.
COPY assets/fonts/ /opt/reelio/fonts/
RUN fc-cache -f /opt/reelio/fonts

# Непривилегированный пользователь: worker'у не нужен root ни для чего.
RUN useradd --system --uid 10001 --create-home --home-dir /home/worker worker \
 && mkdir -p /work \
 && chown -R worker:worker /work

USER worker

ENV NODE_ENV=production \
    REELIO_WORK_DIR=/work \
    REELIO_FONTS_DIR=/opt/reelio/fonts \
    REELIO_LOG_LEVEL=info

ENTRYPOINT ["/usr/bin/tini", "--", "node", "src/index.js"]
