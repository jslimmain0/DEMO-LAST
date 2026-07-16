# FlowLink 내부 서버 배포 — 단일 jar (java -jar)

프론트(dist)가 **jar 안에 동봉**되어 내장 톰캣이 화면+API 를 한 프로세스(:18080)로 서빙한다.
nginx·별도 프론트 서버 불필요. 내부망 전용 구성(h2 프로파일 = H2 파일 DB + SSRF 가드 off — 사내 사설 IP 자유 호출).

## 0. (선택) SSO 로그인 + 팀 격리 — Keycloak (SaaS P1)

기본은 인증 없음(dev 모드, 지금까지와 동일). **여러 팀이 쓰는 공유 인스턴스**로 돌리려면 Keycloak 을 붙인다:

```bash
# Keycloak 기동 (realm flowlink + 롤 admin/editor/viewer/platform-admin + 테스트 유저 자동 import)
docker compose -f deploy/keycloak-dev.compose.yml up -d

# 백엔드를 issuer 로 기동 → 로그인 필수 + RBAC + 팀(tenant 클레임) 격리 활성
SPRING_SECURITY_OAUTH2_RESOURCESERVER_JWT_ISSUER_URI=http://localhost:8081/realms/flowlink \
java -jar flowlink.jar --spring.profiles.active=h2
```

- 테스트 유저(비번=아이디): alice(team-a, admin+platform-admin) / bob(team-a, editor) / carol(team-a, viewer) / dave(team-b, editor)
- SPA 는 `/api/v1/auth/config` 로 인증 모드를 자동 발견(프론트 env 불필요), 화면은 Keycloak 로그인으로 리다이렉트.
- 사용자·팀 관리: Keycloak 관리 콘솔 `http://localhost:8081` (admin/admin) — 유저 attribute `tenant` = 팀 id, realm 롤로 권한.
- 검증: `node e2e/saas-p1-auth.mjs` (27 케이스).
- 실 IdP(Entra/Auth0 등)를 쓰려면 issuer-uri 만 그쪽으로 — 코드는 IdP 비종속. 프록시 뒤라면 realm JSON 의 redirectUris 에 실제 오리진 추가.

## 0.5. (선택) Compose 풀스택 — 앱 + Oracle Free + Keycloak (SaaS P4)

`docker compose up` 한 번으로 **앱(Oracle 프로파일) + Oracle Free 23ai + Keycloak(SSO)** 전부 컨테이너로 뜬다.
사내 Oracle 로 옮길 때는 `FLOWLINK_DB_URL` 만 그쪽으로 바꾸면 된다(스키마는 Flyway `db/migration/oracle` 이 자동 생성).

```bash
# ① 빌드(호스트) — dist 를 jar 에 동봉
cd frontend && npm run build
cd ../backend && gradle bootJar

# ② 스택 기동 (첫 회는 Oracle 이미지 pull + DB 생성으로 수 분)
cd .. && docker compose -f deploy/docker-compose.yml up -d --build

# 접속: http://localhost:18080  (Keycloak 로그인 — 비번=아이디: alice/bob/carol/dave)
# 초기화(데이터 포함 삭제): docker compose -f deploy/docker-compose.yml down -v
```

- 서비스: `app`(:18080, `SPRING_PROFILES_ACTIVE=oracle`) · `oracle`(gvenzl/oracle-free:23-slim, :1521, APP_USER=flowlink) · `keycloak`(:8081, realm 자동 import).
- issuer 이중 주소: 토큰 iss 검증은 `issuer-uri`(브라우저 관점 = `KC_PUBLIC_URL`), JWKS 는 `jwk-set-uri=http://keycloak:8080/...`(컨테이너 내부) — compose env 에 분리 설정됨.
- **공유 서버 배포**: 기본값은 전부 `localhost` 라 개발 PC 단독 실행에 그대로 동작한다. 사내 공유 서버(예: `http://flowlink.corp:18080`)에
  올릴 때는 `deploy/.env.example` 을 `deploy/.env` 로 복사해 `FLOWLINK_APP_ORIGIN`·`KC_PUBLIC_URL`(+운영이면 `FLOWLINK_STATE_SECRET`·
  KC 관리자 비번)을 그 서버 주소로 채우면, Keycloak redirectUris·issuer·CORS 가 자동으로 그 오리진으로 맞춰진다(realm import 의 `${VAR:default}` 치환).
  ```bash
  cp deploy/.env.example deploy/.env   # 편집: FLOWLINK_APP_ORIGIN=http://flowlink.corp:18080, KC_PUBLIC_URL=http://flowlink.corp:8081
  docker compose -f deploy/docker-compose.yml up -d
  ```
  (⚠ 이미 뜬 스택의 realm 은 재import 안 되므로 `.env` 변경 후엔 `down -v` 로 초기화하거나 keycloak 컨테이너를 재생성한다.)
- mock 시드(OIDC 라 editor 이상 토큰 필요):
  ```bash
  TOKEN=$(curl -s http://localhost:8081/realms/flowlink/protocol/openid-connect/token \
    -d grant_type=password -d client_id=flowlink-web -d username=alice -d password=alice | jq -r .access_token)
  FLOWLINK_TOKEN=$TOKEN node demos/seed-mock.mjs
  ```
- 검증: `node e2e/saas-p1-auth.mjs` — RBAC/테넌트 격리 27 케이스가 Oracle 위에서 그대로 통과.
- 운영 전 교체: `FLOWLINK_EXECUTION_STATE_SECRET`(스냅샷 암호키)·Keycloak admin 비번·DB 비번.

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
nohup java -jar flowlink.jar --spring.profiles.active=h2 > flowlink.log 2>&1 &
```

- **콜백 수신 주소는 자동** — wait(콜백 대기) 수신 URL 의 밑둥은 기본적으로 **접속한 주소(오리진)를 그대로** 쓴다
  (`http://서버IP:18080` 으로 접속해 실행하면 콜백 URL 도 그 주소로 조립). 서버는 어차피 `/relay/**` 를 항상
  리슨하고 있고, 이 값은 "밖에 알려줄 주소" 문자열일 뿐이다.
  - 다른 주소(터널/도메인)로 콜백을 받아야 하면: **화면 좌측 하단 ⚙ 설정**에서 저장(서버 DB 보관, 재시작 유지)
    또는 env `FLOWLINK_EXECUTION_RELAY_BASEURL=http://주소:포트`. 우선순위 = 화면 저장값 > env > 접속 주소 자동.
- `FLOWLINK_H2_FILE` — DB 파일 위치(`…/flowlink.mv.db` 로 생성). 생략 시 `~/flowlink-h2db/flowlink`.
- 포트 변경: `FLOWLINK_PORT=포트` — mock base URL·콜백 수신 주소 모두 접속한 주소를 따라가므로 포트를 바꿔도 된다.

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
