#!/usr/bin/env bash
# FlowLink 메인 앱 기동 (Linux/macOS/Git Bash). 단일 jar(화면+API)를 백그라운드로 띄우고 헬스 대기.
#
#   bash scripts/start.sh              # 기존 jar 실행(없으면 --build 안내). 기본 H2.
#   bash scripts/start.sh --build      # 프론트+백엔드 재빌드 후 실행
#
# DB/인증은 env 로 주입(EC2 배포 시 외부 Oracle·Vault 연결):
#   SPRING_PROFILES_ACTIVE=oracle FLOWLINK_DB_URL=... bash scripts/start.sh
# 기본은 H2 파일(로컬). FLOWLINK_PORT(기본 18080)로 포트 변경.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT/.run"; mkdir -p "$RUN_DIR"
PID_FILE="$RUN_DIR/flowlink.pid"
LOG="$RUN_DIR/flowlink.log"
JAR="$ROOT/backend/build/libs/flowlink.jar"
PORT="${FLOWLINK_PORT:-18080}"

BUILD=0
for a in "$@"; do case "$a" in --build) BUILD=1 ;; *) echo "알 수 없는 옵션: $a"; exit 2 ;; esac; done

# JDK 21 해석: PATH → JAVA_HOME → ~/.jdks/*21*
if ! command -v java >/dev/null 2>&1; then
  if [ -n "${JAVA_HOME:-}" ] && { [ -x "$JAVA_HOME/bin/java" ] || [ -f "$JAVA_HOME/bin/java.exe" ]; }; then
    export PATH="$JAVA_HOME/bin:$PATH"
  elif [ -d "$HOME/.jdks" ]; then
    cand="$(ls -d "$HOME/.jdks"/*21* 2>/dev/null | head -1)"
    [ -n "$cand" ] && { export JAVA_HOME="$cand"; export PATH="$cand/bin:$PATH"; echo "JDK 자동 감지: $cand"; }
  fi
fi
command -v java >/dev/null 2>&1 || { echo "❌ java(JDK 21)를 찾을 수 없습니다. JAVA_HOME 설정 필요."; exit 1; }

# 이미 실행 중?
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "이미 실행 중입니다 (PID $(cat "$PID_FILE")). 먼저 scripts/stop.sh 를 실행하세요."; exit 0
fi

# 빌드(옵션 또는 jar 없음)
if [ "$BUILD" -eq 1 ] || [ ! -f "$JAR" ]; then
  echo "▶ 프론트엔드 빌드…"
  ( cd "$ROOT/frontend" && { [ -d node_modules ] || npm ci; } && npm run build )
  echo "▶ 백엔드 bootJar…"
  ( cd "$ROOT/backend" && sh gradlew bootJar -q )
fi
[ -f "$JAR" ] || { echo "❌ jar 이 없습니다: $JAR — 'scripts/start.sh --build' 로 빌드하세요."; exit 1; }

# 기본 H2(로컬) — env 로 프로파일/DB 를 안 주면 h2
export SPRING_PROFILES_ACTIVE="${SPRING_PROFILES_ACTIVE:-h2}"

# 추가 JVM 옵션(공백 구분). 사내 TLS 가로채기 프록시 환경이면 커스텀 truststore 를 여기로:
#   FLOWLINK_JAVA_OPTS="-Djavax.net.ssl.trustStore=/etc/pki/corp.jks -Djavax.net.ssl.trustStorePassword=..."
JVM_OPTS="${FLOWLINK_JAVA_OPTS:-}"

echo "▶ FlowLink 기동 (profile=$SPRING_PROFILES_ACTIVE, port=$PORT)…"
# shellcheck disable=SC2086
nohup env FLOWLINK_PORT="$PORT" java $JVM_OPTS -jar "$JAR" >> "$LOG" 2>&1 < /dev/null &
echo $! > "$PID_FILE"

for _ in $(seq 1 60); do
  if curl -fs "http://localhost:$PORT/actuator/health" >/dev/null 2>&1; then
    echo "✅ 기동 완료 — http://localhost:$PORT  (PID $(cat "$PID_FILE"), 로그 $LOG)"; exit 0
  fi
  sleep 1
done
echo "⚠ 60초 내 헬스 UP 실패. 로그 확인: $LOG"; exit 1
