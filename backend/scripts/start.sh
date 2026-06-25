#!/usr/bin/env bash
# Flowlink 백엔드 시작 스크립트 (Git Bash / Linux / macOS).
# Postgres(docker)를 띄우고 → (필요 시)빌드 → Spring Boot 앱을 백그라운드 실행하고
# PID/로그를 .run/ 에 기록한 뒤 헬스가 UP 될 때까지 대기한다.
#
# 사용법:
#   bash scripts/start.sh            # 기본(DB+빌드(없으면)+백그라운드)
#   bash scripts/start.sh --build    # 강제 재빌드
#   bash scripts/start.sh --no-db    # 외부 DB 사용(docker 생략)
#   bash scripts/start.sh -f         # 포그라운드(gradlew bootRun)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_DIR="$BACKEND/.run"; mkdir -p "$RUN_DIR"
PID_FILE="$RUN_DIR/flowlink.pid"
LOG="$RUN_DIR/flowlink.log"
JAR="$BACKEND/build/libs/flowlink.jar"
PORT="${FLOWLINK_PORT:-18080}"

NO_DB=0; BUILD=0; FOREGROUND=0; H2=0
for a in "$@"; do
  case "$a" in
    --no-db) NO_DB=1 ;;
    --build) BUILD=1 ;;
    --foreground|-f) FOREGROUND=1 ;;
    --h2) H2=1 ;;
    *) echo "알 수 없는 옵션: $a"; exit 2 ;;
  esac
done

# H2 모드: Spring 프로파일 활성 + Postgres 생략
if [ "$H2" -eq 1 ]; then
  export SPRING_PROFILES_ACTIVE=h2
  echo "H2 인메모리 모드 (프로파일=h2, Postgres 생략)"
fi

# JDK 자동 감지: PATH → JAVA_HOME → ~/.jdks/*(21 우선)
resolve_jdk() {
  command -v java >/dev/null 2>&1 && return 0
  if [ -n "${JAVA_HOME:-}" ] && { [ -x "$JAVA_HOME/bin/java" ] || [ -f "$JAVA_HOME/bin/java.exe" ]; }; then
    export PATH="$JAVA_HOME/bin:$PATH"; return 0
  fi
  local root="$HOME/.jdks" cand=""
  if [ -d "$root" ]; then
    cand="$(ls -d "$root"/*21* 2>/dev/null | head -1)"
    [ -z "$cand" ] && cand="$(ls -d "$root"/*/ 2>/dev/null | sed 's:/*$::' | head -1)"
    if [ -n "$cand" ] && { [ -x "$cand/bin/java" ] || [ -f "$cand/bin/java.exe" ]; }; then
      export JAVA_HOME="$cand"; export PATH="$cand/bin:$PATH"; echo "JDK 자동 감지: $cand"
    fi
  fi
}
resolve_jdk
command -v java >/dev/null 2>&1 || [ -n "${JAVA_HOME:-}" ] || { echo "java(JDK 21)를 찾을 수 없습니다. JAVA_HOME 설정 필요."; exit 1; }

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "이미 실행 중입니다 (PID $(cat "$PID_FILE")). 먼저 stop.sh 를 실행하세요."; exit 0
fi

if [ "$NO_DB" -eq 0 ] && [ "$H2" -eq 0 ]; then
  if command -v docker >/dev/null 2>&1; then
    echo "Postgres 기동 (docker compose up -d)..."
    ( cd "$BACKEND" && docker compose up -d )
    printf "Postgres 헬스 대기"
    for _ in $(seq 1 30); do
      if docker exec flowlink-postgres pg_isready -U flowlink -d flowlink >/dev/null 2>&1; then break; fi
      sleep 2; printf "."
    done; echo
  else
    echo "docker 가 없습니다 — Postgres 기동 생략(외부 DB 필요)."
  fi
fi

if [ "$BUILD" -eq 1 ] || [ ! -f "$JAR" ]; then
  echo "빌드 (gradlew bootJar)..."
  ( cd "$BACKEND" && ./gradlew bootJar )
fi

if [ "$FOREGROUND" -eq 1 ]; then
  echo "포그라운드 실행 (Ctrl+C 로 종료)"
  exec sh -c "cd '$BACKEND' && ./gradlew bootRun"
fi

( cd "$BACKEND" && nohup java -jar "$JAR" > "$LOG" 2>&1 & echo $! > "$PID_FILE" )
APP_PID="$(cat "$PID_FILE")"
echo "시작됨 (PID $APP_PID). 로그: $LOG"

printf "앱 헬스 대기 (http://localhost:%s/actuator/health)" "$PORT"
for _ in $(seq 1 60); do
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    echo; echo "앱이 비정상 종료되었습니다. 로그: $LOG"; exit 1
  fi
  if curl -sf "http://localhost:$PORT/actuator/health" >/dev/null 2>&1; then
    echo; echo "READY ✓  → http://localhost:$PORT/swagger-ui.html"; exit 0
  fi
  sleep 2; printf "."
done
echo; echo "헬스 확인 시간 초과. 로그: $LOG"
