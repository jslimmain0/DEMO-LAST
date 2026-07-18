#!/usr/bin/env bash
# FlowLink 메인 앱 중지 (Linux/macOS/Git Bash).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT/.run/flowlink.pid"

[ -f "$PID_FILE" ] || { echo "PID 파일 없음 — 실행 중이 아닙니다."; exit 0; }
PID="$(cat "$PID_FILE")"
if ! kill -0 "$PID" 2>/dev/null; then
  echo "프로세스(PID $PID) 없음 — PID 파일만 정리."; rm -f "$PID_FILE"; exit 0
fi

echo "▶ 중지 (PID $PID)…"
kill "$PID" 2>/dev/null || true
for _ in $(seq 1 20); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
kill -0 "$PID" 2>/dev/null && { echo "  강제 종료(-9)"; kill -9 "$PID" 2>/dev/null || true; }
rm -f "$PID_FILE"
echo "✅ 중지 완료."
