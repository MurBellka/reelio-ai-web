# Образ FFmpeg render worker'а (Cloud Run Job).
#
# Зависимостей npm нет вообще — весь код на стандартной библиотеке Node,
# включая обращения к Cloud Storage через fetch. Поэтому ни `npm ci`, ни
# lock-файла, ни отдельного build-этапа здесь не требуется: образ — это
# «ffmpeg + node + src/».
#
# ffmpeg из Debian bookworm (5.1.x) собран с libass, libfreetype и libx264,
# то есть умеет всё, что нужно контракту: xfade, zoompan, sidechaincompress,
# loudnorm, alimiter и вшивание ASS-субтитров. Минимальная поддерживаемая
# версия — 5.1; более старые сборки не знают части режимов xfade (worker в
# этом случае откатывается на растворение, см. src/filtergraph.js).

FROM node:22-bookworm-slim

# fonts-dejavu-core — кириллица в субтитрах. tini — корректная обработка
# сигналов: Cloud Run шлёт SIGTERM при отмене, и FFmpeg должен успеть закрыть
# файлы (§8.1).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg \
      fonts-dejavu-core \
      fontconfig \
      ca-certificates \
      tini \
 && fc-cache -f \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
COPY src/ ./src/

# Непривилегированный пользователь: worker'у не нужен root ни для чего.
RUN useradd --system --uid 10001 --create-home --home-dir /home/worker worker \
 && mkdir -p /work /opt/reelio/music \
 && chown -R worker:worker /work /opt/reelio

USER worker

ENV NODE_ENV=production \
    REELIO_WORK_DIR=/work \
    REELIO_FONTS_DIR=/usr/share/fonts \
    REELIO_FONT_NAME="DejaVu Sans" \
    REELIO_MUSIC_DIR=/opt/reelio/music \
    REELIO_LOG_LEVEL=info

# Настоящие музыкальные треки монтируются в /opt/reelio/music как
# {chill,energy,cinematic,trending}.m4a. Без них worker синтезирует подложку
# (см. src/music.js) — рендер и ducking остаются рабочими.

ENTRYPOINT ["/usr/bin/tini", "--", "node", "src/index.js"]
