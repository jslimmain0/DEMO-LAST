#!/usr/bin/env bash
# Flowlink 백엔드 종료 스크립트 (Git Bash / Linux / macOS).
# .run/flowlink.pid 의 앱을 종료하고, 기본적으로 Postgres(docker) 컨테이너도 정지(볼륨 보존).
#
# 사용법:
#   bash scripts/stop.sh             # 앱 + Postgres 정지(볼륨 보존)
#   bash scripts/stop.sh --keep-db   # 앱만 종료
#   bash scripts/stop.sh --remove-db # Postgres 컨테이너+볼륨까지 제거
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_FILE="$BACKEND/.run/flowlink.pid"

KEEP_DB=0; REMOVE_DB=0
for a in "$@"; do
  case "$a" in
    --keep-db) KEEP_DB=1 ;;
    --remove-db) REMOVE_DB=1 ;;
    *) echo "알 수 없는 옵션: $a"; exit 2 ;;
  esac
done

# 1) 앱 종료
if [ -f "$PID_FILE" ]; then
  APP_PID="$(cat "$PID_FILE")"
  if kill -0 "$APP_PID" 2>/dev/null; then
    echo "앱 종료 (PID $APP_PID)..."
    kill "$APP_PID" 2>/dev/null || true
    for _ in $(seq 1 10); do kill -0 "$APP_PID" 2>/dev/null || break; sleep 1; done
    if kill -0 "$APP_PID" 2>/dev/null; then kill -9 "$APP_PID" 2>/dev/null || true; fi
    echo "앱이 종료되었습니다."
  else
    echo "실행 중인 앱이 없습니다 (PID $APP_PID)."
  fi
  rm -f "$PID_FILE"
else
  echo "PID 파일이 없습니다 — 백그라운드 앱이 없습니다."
fi

# 2) Postgres
if [ "$KEEP_DB" -eq 0 ] && command -v docker >/dev/null 2>&1; then
  if [ "$REMOVE_DB" -eq 1 ]; then
    echo "Postgres 컨테이너+볼륨 제거 (docker compose down -v)..."
    ( cd "$BACKEND" && docker compose down -v )
  else
    echo "Postgres 컨테이너 정지 (docker compose stop)..."
    ( cd "$BACKEND" && docker compose stop )
  fi
else
  [ "$KEEP_DB" -eq 1 ] && echo "Postgres 는 그대로 둡니다 (--keep-db)."
fi
