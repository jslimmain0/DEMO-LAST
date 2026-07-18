#!/usr/bin/env bash
# FlowLink 메인 앱 상태 (Linux/macOS/Git Bash). PID 생존 + 헬스 확인.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT/.run/flowlink.pid"
PORT="${FLOWLINK_PORT:-18080}"

RUNNING=0
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  RUNNING=1; echo "프로세스: 실행 중 (PID $(cat "$PID_FILE"))"
else
  echo "프로세스: 중지됨"
fi

if curl -fs "http://localhost:$PORT/actuator/health" >/dev/null 2>&1; then
  echo "헬스   : ✅ UP (http://localhost:$PORT)"
  exit 0
else
  echo "헬스   : ❌ DOWN (http://localhost:$PORT)"
  [ "$RUNNING" -eq 1 ] && { echo "(프로세스는 살아있으나 헬스 응답 없음 — 기동 중이거나 오류. 로그: $ROOT/.run/flowlink.log)"; exit 1; }
  exit 1
fi
