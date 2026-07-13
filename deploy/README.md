# FlowLink 내부 서버 배포 — 단일 jar (java -jar)

프론트(dist)가 **jar 안에 동봉**되어 내장 톰캣이 화면+API 를 한 프로세스(:18080)로 서빙한다.
nginx·별도 프론트 서버 불필요. 내부망 전용 구성(h2 프로파일 = H2 파일 DB + SSRF 가드 off — 사내 사설 IP 자유 호출).

## 1. 빌드 (개발 PC)

```bash
# ① 프론트 빌드 (dist 생성)
cd frontend && npm ci && npm run build

# ② 백엔드 bootJar — frontend/dist 를 자동으로 jar 에 동봉
cd ../backend && gradle bootJar
# → backend/build/libs/flowlink.jar  (이 파일 하나가 배포물 전부)

# (선택) 변환 플러그인
gradle :plugin-sample:jar
# → backend/plugin-sample/build/libs/flowlink-plugin-sample.jar
```

> 순서 중요: **npm run build 를 먼저** 해야 dist 가 jar 에 들어간다. dist 가 없으면 API 만 담긴 jar 가 된다.

## 2. 서버 준비 (Ubuntu, 최초 1회)

```bash
sudo apt install -y openjdk-21-jre-headless   # JDK 21 필수
mkdir -p ~/flowlink/data ~/flowlink/plugins   # data=H2 파일, plugins=변환 플러그인 JAR
```

## 3. 올리고 실행

```bash
# 개발 PC 에서
scp backend/build/libs/flowlink.jar  사용자@서버:~/flowlink/
# (선택) scp backend/plugin-sample/build/libs/flowlink-plugin-sample.jar 사용자@서버:~/flowlink/plugins/

# 서버에서 — 반드시 ~/flowlink 에서 실행(plugins/ 가 작업 디렉토리 기준 상대경로)
cd ~/flowlink
FLOWLINK_H2_FILE=$HOME/flowlink/data/flowlink \
FLOWLINK_EXECUTION_RELAY_BASEURL=http://<서버IP>:18080 \
nohup java -jar flowlink.jar --spring.profiles.active=h2 > flowlink.log 2>&1 &
```

- **`FLOWLINK_EXECUTION_RELAY_BASEURL`** ← 필수. wait(콜백 대기) 수신 URL 이 이 주소로 만들어진다.
  기본값(localhost)이면 다른 시스템이 콜백을 못 보낸다. `<서버IP>` 자리에 사내에서 접근하는 실제 IP/호스트명.
- `FLOWLINK_H2_FILE` — DB 파일 위치(`…/flowlink.mv.db` 로 생성). 생략 시 `~/flowlink-h2db/flowlink`.
- 포트 변경: `FLOWLINK_PORT=포트` — mock base URL 복사는 **접속한 주소(오리진)를 그대로 따라가므로** 포트를 바꿔도 된다.
  (relay base 오버라이드의 포트도 같이 바꿀 것)

종료: `kill $(pgrep -f flowlink.jar)`

## 4. 확인 (스모크 체크)

1. 브라우저에서 `http://서버IP:18080/` → 대시보드가 뜬다
2. 워크플로 열고 **새로고침**(`/flows/{id}`) → 404 없이 그대로 뜬다 (SPA fallback)
3. 플로우 하나 실행 → SUCCEEDED
4. wait 노드 실행 → 실행 로그의 수신 URL 이 `http://서버IP:18080/relay/...` 인지 → 다른 PC 에서 그 URL 로 `curl -X POST` → 실행이 재개된다
5. Mock 서버 탭에서 base URL 복사 → 그 주소가 호출된다
6. (선택) 데모 mock 시드: `FLOWLINK_BASE=http://서버IP:18080 node demos/seed-mock.mjs`

## 5. 운영

| 작업 | 방법 |
|---|---|
| 업데이트 | 새 flowlink.jar 로 교체 → kill 후 다시 3번 명령으로 실행 |
| 백업 | 프로세스 종료 후 `~/flowlink/data/flowlink.mv.db` 파일 복사 |
| 로그 | `tail -f ~/flowlink/flowlink.log` |
| DB 초기화 | 종료 후 `flowlink.mv.db` 삭제(다음 기동 때 새로 생성) |
| 플러그인 추가 | UI/API 업로드(즉시 반영) 또는 `~/flowlink/plugins/` 에 JAR 두고 재시작 |
