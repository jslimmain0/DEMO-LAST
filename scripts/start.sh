#!/usr/bin/env bash
# FlowLink 메인 앱 기동 (Linux/macOS/Git Bash). 단일 jar(화면+API)를 백그라운드로 띄우고 헬스 대기.
#
#   bash scripts/start.sh              # 기존 jar 실행(없으면 --build 안내). 기본 프로파일 local(H2 파일).
#   bash scripts/start.sh --build      # 프론트+백엔드 재빌드 후 실행
#
# DB/인증은 env 로 주입(EC2 배포 시 외부 Oracle·Vault 연결):
#   SPRING_PROFILES_ACTIVE=dev FLOWLINK_DB_URL=... bash scripts/start.sh
# 기본은 local(H2 파일). FLOWLINK_PORT(기본 18080)로 포트 변경.
# 경로 접두사(context path): FLOWLINK_CONTEXT_PATH=/flowlink → http://host:port/flowlink/ (앞 슬래시 필수, 끝 슬래시 없음).
# MCP HTTP 서버(에이전트용, Node 20+): jar 옆에 node mcp/src/index.js --http 를 함께 띄운다 — http://host:FLOWLINK_MCP_PORT/mcp (기본 18090).
#   FLOWLINK_MCP_PORT=0 이면 안 띄움. node 가 없으면 경고만 하고 jar 만 뜬다. 설정 화면(⚙)이 접속 주소·토큰 복사를 안내한다.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT/.run"; mkdir -p "$RUN_DIR"
PID_FILE="$RUN_DIR/flowlink.pid"
LOG="$RUN_DIR/flowlink.log"
MCP_PID_FILE="$RUN_DIR/flowlink-mcp.pid"
MCP_LOG="$RUN_DIR/flowlink-mcp.log"
MCP_PORT="${FLOWLINK_MCP_PORT:-18090}"
JAR="$ROOT/backend/build/libs/flowlink.jar"
PORT="${FLOWLINK_PORT:-18080}"
CTX="${FLOWLINK_CONTEXT_PATH:-}"; CTX="${CTX#/}"; CTX="${CTX%/}"; [ -n "$CTX" ] && CTX="/$CTX"   # 정규화: /flowlink (Spring 규약)

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
# MCP HTTP 서버 의존성(순수 JS, 빌드 없음 — node_modules 만)
if [ "$MCP_PORT" != "0" ] && command -v node >/dev/null 2>&1 && [ ! -d "$ROOT/mcp/node_modules" ]; then
  echo "▶ MCP 의존성 설치…"; ( cd "$ROOT/mcp" && npm ci --no-audit --no-fund )
fi
[ -f "$JAR" ] || { echo "❌ jar 이 없습니다: $JAR — 'scripts/start.sh --build' 로 빌드하세요."; exit 1; }

# 기본 local(H2 파일) — env 로 프로파일을 안 주면 local
export SPRING_PROFILES_ACTIVE="${SPRING_PROFILES_ACTIVE:-local}"

# 추가 JVM 옵션(공백 구분). 사내 TLS 가로채기 프록시 환경이면 커스텀 truststore 를 여기로:
#   FLOWLINK_JAVA_OPTS="-Djavax.net.ssl.trustStore=/etc/pki/corp.jks -Djavax.net.ssl.trustStorePassword=..."
JVM_OPTS="${FLOWLINK_JAVA_OPTS:-}"

echo "▶ FlowLink 기동 (profile=$SPRING_PROFILES_ACTIVE, port=$PORT)…"
# shellcheck disable=SC2086
# FLOWLINK_MCP_PORT 는 jar 에도 준다 — /auth/config 가 설정 화면에 MCP 접속 포트를 알려주게(0 이면 미설정으로).
MCP_PORT_FOR_JAR="$MCP_PORT"; [ "$MCP_PORT" = "0" ] && MCP_PORT_FOR_JAR=""
nohup env FLOWLINK_PORT="$PORT" FLOWLINK_CONTEXT_PATH="$CTX" FLOWLINK_MCP_PORT="$MCP_PORT_FOR_JAR" java $JVM_OPTS -jar "$JAR" >> "$LOG" 2>&1 < /dev/null &
echo $! > "$PID_FILE"

# MCP HTTP 서버 — jar 헬스와 무관하게 먼저 띄운다(REST 가 늦게 떠도 툴 호출 시점에만 연결하면 된다).
if [ "$MCP_PORT" != "0" ]; then
  if command -v node >/dev/null 2>&1; then
    if [ -f "$MCP_PID_FILE" ] && kill -0 "$(cat "$MCP_PID_FILE")" 2>/dev/null; then
      echo "MCP 서버 이미 실행 중 (PID $(cat "$MCP_PID_FILE"))"
    else
      nohup env FLOWLINK_URL="http://localhost:$PORT$CTX" FLOWLINK_MCP_PORT="$MCP_PORT" node "$ROOT/mcp/src/index.js" --http >> "$MCP_LOG" 2>&1 < /dev/null &
      echo $! > "$MCP_PID_FILE"
      echo "▶ MCP HTTP 서버 — http://localhost:$MCP_PORT/mcp (PID $(cat "$MCP_PID_FILE"), 로그 $MCP_LOG)"
    fi
  else
    echo "⚠ node 가 없어 MCP HTTP 서버를 띄우지 않습니다(Node 20+ 설치 또는 FLOWLINK_MCP_PORT=0). stdio 설치형(tgz)은 그대로 됩니다."
  fi
fi

for _ in $(seq 1 60); do
  if curl -fs "http://localhost:$PORT$CTX/api/v1/auth/config" >/dev/null 2>&1; then
    echo "✅ 기동 완료 — http://localhost:$PORT  (PID $(cat "$PID_FILE"), 로그 $LOG)"; exit 0
  fi
  sleep 1
done
echo "⚠ 60초 내 헬스 UP 실패. 로그 확인: $LOG"; exit 1
