#!/usr/bin/env bash
# End-to-end проверка рендера БЕЗ облачных ресурсов.
#
# Что делает:
#   1. генерирует настоящие исходники (ffmpeg): видео 1080×1920 + фото;
#   2. поднимает backend в local mode (состояние в памяти, файлы на диске);
#   3. отправляет POST /render и ждёт задачу через GET /jobs/{id};
#   4. скачивает результат по ссылке из /download;
#   5. проверяет ffprobe'ом, что это настоящий MP4: H.264/AAC, нужное
#      разрешение 9:16 и осмысленная длительность.
#
# Прогоняется для каждого разрешения из аргументов (по умолчанию 720p и 1080p).
#
# FFmpeg worker запускается через LOCAL_WORKER_CMD. Пока ветка worker'а не
# объединена, скрипт честно сообщает, что обработчика нет, и выходит с кодом 2 —
# это не поломка backend'а.
#
# Использование:
#   scripts/e2e-render.sh                    # hd720 и fullHd1080
#   scripts/e2e-render.sh fourK2160          # только 4K
#   LOCAL_WORKER_CMD='node worker/index.js' scripts/e2e-render.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESOLUTIONS=("$@")
[ ${#RESOLUTIONS[@]} -eq 0 ] && RESOLUTIONS=(hd720 fullHd1080)

PORT="${E2E_PORT:-8791}"
BASE="http://127.0.0.1:${PORT}"
WORKER_TOKEN="e2e-worker-token"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/reelio-e2e-XXXXXX")"
RENDER_ROOT="${WORK_DIR}/render"
SERVER_LOG="${WORK_DIR}/backend.log"
SERVER_PID=""

# Ожидаемые размеры кадра 9:16 для каждого разрешения (контракт §1).
expected_dims() {
  case "$1" in
    hd720)      echo "720 1280" ;;
    fullHd1080) echo "1080 1920" ;;
    twoK1440)   echo "1440 2560" ;;
    fourK2160)  echo "2160 3840" ;;
    *) echo "" ;;
  esac
}

cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  if [ "${E2E_KEEP:-0}" = "1" ]; then
    echo "→ артефакты сохранены: $WORK_DIR"
  else
    rm -rf "$WORK_DIR"
  fi
}
trap cleanup EXIT

fail() { echo "✖ $*" >&2; exit 1; }
ok()   { echo "✔ $*"; }

for tool in ffmpeg ffprobe jq curl node; do
  command -v "$tool" >/dev/null || fail "не найден $tool"
done

# ── 1. Настоящие исходники ────────────────────────────────────────────────
PROJECT_ID="e2e_$(date +%s)"
SRC_DIR="${WORK_DIR}/sources"
mkdir -p "$SRC_DIR"

echo "→ генерация исходников (ffmpeg)"
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc=size=1080x1920:rate=30:duration=12" \
  -f lavfi -i "sine=frequency=440:duration=12" \
  -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest \
  "${SRC_DIR}/asset_a.mp4"
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc=size=1080x1920:rate=1:duration=1" -frames:v 1 \
  "${SRC_DIR}/asset_b.jpg"
ok "исходники готовы: $(du -sh "$SRC_DIR" | cut -f1)"

# ── 2. Backend в local mode ───────────────────────────────────────────────
WORKER_CMD="${LOCAL_WORKER_CMD:-}"
if [ -z "$WORKER_CMD" ]; then
  for candidate in "${REPO_ROOT}/backend/worker/src/index.js" "${REPO_ROOT}/worker/src/index.js"; do
    [ -f "$candidate" ] && WORKER_CMD="node ${candidate}" && break
  done
fi

echo "→ запуск backend на :${PORT} (local mode)"
(
  cd "${REPO_ROOT}/backend"
  PORT="$PORT" \
  LOCAL_RENDER_ROOT="$RENDER_ROOT" \
  LOCAL_WORKER_CMD="$WORKER_CMD" \
  PUBLIC_BASE_URL="$BASE" \
  WORKER_TOKEN="$WORKER_TOKEN" \
  RATE_LIMIT_RENDER=1000 RATE_LIMIT_POLL=100000 \
  node server.js >"$SERVER_LOG" 2>&1 &
  echo $! >"${WORK_DIR}/server.pid"
)
SERVER_PID="$(cat "${WORK_DIR}/server.pid")"

for _ in $(seq 1 50); do
  curl -fsS "${BASE}/health" >/dev/null 2>&1 && break
  sleep 0.2
done
HEALTH="$(curl -fsS "${BASE}/health")" || fail "backend не поднялся; лог: $SERVER_LOG"
[ "$(jq -r .render.mode <<<"$HEALTH")" = "local" ] || fail "ожидался режим local"
ok "backend жив: $(jq -c . <<<"$HEALTH")"

# ── 2b. Загрузка исходников через POST /uploads (§8.2) ────────────────────
echo "→ запрос разрешений на загрузку"
UPLOAD_REQ="$(jq -n --arg p "$PROJECT_ID" '{
  contractVersion: 1,
  projectId: $p,
  assets: [
    { id: "asset_a", type: "video",
      objectPath: ("projects/" + $p + "/sources/asset_a.mp4"),
      contentType: "video/mp4" },
    { id: "asset_b", type: "photo",
      objectPath: ("projects/" + $p + "/sources/asset_b.jpg"),
      contentType: "image/jpeg" }
  ]}')"

TICKETS="$(curl -fsS -X POST "${BASE}/uploads" \
  -H 'Content-Type: application/json' -d "$UPLOAD_REQ")" \
  || fail "POST /uploads не отработал"
[ "$(jq '.uploads | length' <<<"$TICKETS")" = "2" ] || fail "ожидалось 2 разрешения"

for asset in asset_a:mp4:video/mp4 asset_b:jpg:image/jpeg; do
  IFS=: read -r aid ext ctype <<<"$asset"
  url="$(jq -r --arg id "$aid" '.uploads[] | select(.assetId==$id) | .uploadUrl' <<<"$TICKETS")"
  [ -n "$url" ] && [ "$url" != "null" ] || fail "нет ссылки для ${aid}"
  curl -fsS -X PUT -H "Content-Type: ${ctype}" \
    --data-binary "@${SRC_DIR}/${aid}.${ext}" "$url" >/dev/null \
    || fail "загрузка ${aid} не удалась"
done
ok "материалы загружены напрямую в хранилище"

if [ -z "$WORKER_CMD" ]; then
  echo
  echo "⚠ FFmpeg worker не найден (нет worker/index.js и не задан LOCAL_WORKER_CMD)."
  echo "  Backend и загрузка проверены; настоящий MP4 появится после объединения"
  echo "  ветки worktree-ffmpeg-worker. Запустите скрипт повторно после merge."
  exit 2
fi
ok "обработчик: $WORKER_CMD"

# ── 3-5. Прогон по разрешениям ────────────────────────────────────────────
render_one() {
  local resolution="$1"
  local dims; dims="$(expected_dims "$resolution")"
  [ -n "$dims" ] || fail "неизвестное разрешение $resolution"
  local exp_w exp_h; read -r exp_w exp_h <<<"$dims"

  echo
  echo "═══ ${resolution} (${exp_w}×${exp_h}) ═══"

  local body
  body="$(jq -n --arg p "$PROJECT_ID" --arg r "$resolution" '{
    contractVersion: 1,
    projectId: $p,
    assets: [
      { id: "asset_a", type: "video",
        objectPath: ("projects/" + $p + "/sources/asset_a.mp4"),
        durationSeconds: 12, width: 1080, height: 1920 },
      { id: "asset_b", type: "photo",
        objectPath: ("projects/" + $p + "/sources/asset_b.jpg"),
        width: 1080, height: 1920 }
    ],
    plan: {
      id: ("plan_" + $r),
      prompt: "end-to-end проверка рендера",
      style: "dynamicStyle",
      durationSeconds: 8,
      captions: { enabled: true, language: "ru", style: "bold",
                  colorHex: "#FFFFFF", sampleText: "Проверка субтитров" },
      music: { track: "chill", volume: 0.7 },
      clips: [
        { id: "clip_1", mediaId: "asset_a", type: "video",
          duration: 5, start: 1, end: 6, transition: "cut" },
        { id: "clip_2", mediaId: "asset_b", type: "photo",
          duration: 3, transition: "crossfade" }
      ]
    },
    export: { resolution: $r, fps: 30 }
  }')"

  local created http job_id
  created="$(curl -sS -w '\n%{http_code}' -X POST "${BASE}/render" \
    -H 'Content-Type: application/json' \
    -H "Idempotency-Key: e2e-${resolution}" \
    -d "$body")"
  http="$(tail -n1 <<<"$created")"
  created="$(sed '$d' <<<"$created")"
  [ "$http" = "202" ] || fail "POST /render вернул ${http}: $(jq -c . <<<"$created")"

  job_id="$(jq -r .jobId <<<"$created")"
  ok "задача создана: ${job_id} (${http})"

  # Проверяем идемпотентность на живой системе: повтор не плодит задачи.
  local dup_id
  dup_id="$(curl -sS -X POST "${BASE}/render" -H 'Content-Type: application/json' \
    -H "Idempotency-Key: e2e-${resolution}" -d "$body" | jq -r .jobId)"
  [ "$dup_id" = "$job_id" ] || fail "дубликат создал новую задачу ${dup_id}"
  ok "защита от дубликатов работает"

  # ── ожидание ────────────────────────────────────────────────────────────
  local deadline=$(( $(date +%s) + ${E2E_TIMEOUT:-600} ))
  local status phase progress last=""
  while :; do
    local state; state="$(curl -sS "${BASE}/jobs/${job_id}")"
    status="$(jq -r .status <<<"$state")"
    phase="$(jq -r .phase <<<"$state")"
    progress="$(jq -r .progress <<<"$state")"
    if [ "${phase}/${progress}" != "$last" ]; then
      printf '  %-12s %5.0f%%  %s\n' "$phase" "$(bc -l <<<"$progress * 100")" \
        "$(jq -r .message <<<"$state")"
      last="${phase}/${progress}"
    fi
    case "$status" in
      succeeded) break ;;
      failed|cancelled)
        echo "$state" | jq . >&2
        fail "задача завершилась со статусом ${status}" ;;
    esac
    [ "$(date +%s)" -lt "$deadline" ] || fail "таймаут ожидания задачи ${job_id}"
    sleep 2
  done
  ok "рендер завершён"

  # ── скачивание ──────────────────────────────────────────────────────────
  local dl url out
  dl="$(curl -sS "${BASE}/download?jobId=${job_id}")"
  url="$(jq -r .downloadUrl <<<"$dl")"
  [ -n "$url" ] && [ "$url" != "null" ] || fail "нет ссылки на скачивание"
  out="${WORK_DIR}/reel_${resolution}.mp4"
  curl -fsS -o "$out" "$url" || fail "не удалось скачать результат"
  ok "скачано: $(du -h "$out" | cut -f1) → $(jq -r .fileName <<<"$dl")"

  # ── проверка настоящего MP4 ─────────────────────────────────────────────
  local probe vcodec acodec width height duration
  probe="$(ffprobe -v error -print_format json -show_streams -show_format "$out")" \
    || fail "ffprobe не смог прочитать файл — это не валидный MP4"

  vcodec="$(jq -r '.streams[] | select(.codec_type=="video") | .codec_name' <<<"$probe" | head -1)"
  acodec="$(jq -r '.streams[] | select(.codec_type=="audio") | .codec_name' <<<"$probe" | head -1)"
  width="$(jq -r '.streams[] | select(.codec_type=="video") | .width' <<<"$probe" | head -1)"
  height="$(jq -r '.streams[] | select(.codec_type=="video") | .height' <<<"$probe" | head -1)"
  duration="$(jq -r '.format.duration' <<<"$probe")"

  [ "$vcodec" = "h264" ] || fail "видеокодек ${vcodec}, ожидался h264"
  [ "$acodec" = "aac" ]  || fail "аудиокодек ${acodec}, ожидался aac"
  [ "$width" = "$exp_w" ] && [ "$height" = "$exp_h" ] \
    || fail "кадр ${width}×${height}, ожидался ${exp_w}×${exp_h}"
  awk -v d="$duration" 'BEGIN { exit !(d > 6 && d < 10) }' \
    || fail "длительность ${duration}s вне ожидаемого диапазона 6–10s"

  ok "настоящий MP4: ${vcodec}/${acodec} ${width}×${height} ${duration}s"
}

for r in "${RESOLUTIONS[@]}"; do
  render_one "$r"
done

echo
echo "═══════════════════════════════════════"
ok "end-to-end пройден: ${RESOLUTIONS[*]}"
