#!/usr/bin/env bash
# FlowLink 메인 앱 + MCP HTTP 서버 중지 (Linux/macOS/Git Bash).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# stop_one <이름> <PID 파일>
stop_one() {
  local name="$1" pid_file="$2" pid
  [ -f "$pid_file" ] || { echo "$name: PID 파일 없음 — 실행 중이 아닙니다."; return 0; }
  pid="$(cat "$pid_file")"
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "$name: 프로세스(PID $pid) 없음 — PID 파일만 정리."; rm -f "$pid_file"; return 0
  fi
  echo "▶ $name 중지 (PID $pid)…"
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  kill -0 "$pid" 2>/dev/null && { echo "  강제 종료(-9)"; kill -9 "$pid" 2>/dev/null || true; }
  rm -f "$pid_file"
}

stop_one "MCP 서버" "$ROOT/.run/flowlink-mcp.pid"
stop_one "FlowLink" "$ROOT/.run/flowlink.pid"
echo "✅ 중지 완료."
