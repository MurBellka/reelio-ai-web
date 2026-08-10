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
COPY assets/fonts/ /usr/share/fonts/truetype/reelio/
# fc-cache без аргументов перечитывает все стандартные каталоги: fontconfig
# сканирует только их, и шрифт вне такого каталога libass не найдёт по имени.
RUN fc-cache -f

# Обязательные проверки окружения — те же, что в Dockerfile.verify. Без них
# смена базового образа могла бы молча выкатить сборку ffmpeg без libass или
# без шрифтов: тогда worker не падает, а тихо отдаёт ролик без подписей.
# 1) фильтр subtitles (то есть libass) присутствует;
RUN ffmpeg -hide_banner -filters 2>/dev/null | grep -q ' subtitles ' \
 || (echo 'ffmpeg собран без libass — фильтр subtitles недоступен' && exit 1)
# 2) базовое семейство каталога установлено и видно fontconfig;
RUN fc-list | grep -qi 'montserrat' \
 || (echo 'шрифт Montserrat не найден в /usr/share/fonts/truetype/reelio' && exit 1)
# 3) отдельное имя Medium индексируется — иначе вес medium молча стал бы Regular.
RUN fc-list | grep -qi 'montserrat medium' \
 || (echo 'начертание «Montserrat Medium» не проиндексировано fontconfig — medium выпал бы в Regular' && exit 1)

# Непривилегированный пользователь: worker'у не нужен root ни для чего.
RUN useradd --system --uid 10001 --create-home --home-dir /home/worker worker \
 && mkdir -p /work \
 && chown -R worker:worker /work

USER worker

ENV NODE_ENV=production \
    REELIO_WORK_DIR=/work \
    REELIO_FONTS_DIR=/usr/share/fonts/truetype/reelio \
    REELIO_LOG_LEVEL=info

ENTRYPOINT ["/usr/bin/tini", "--", "node", "src/index.js"]
