# SaaS P4 — Oracle 지원 + Docker Compose 배포 스택 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `docker compose up` 한 번으로 앱(flowlink.jar) + Oracle Free 23ai + Keycloak 이 뜨고, Oracle 위에서 마이그레이션·로그인·RBAC·데모 실행이 동작한다.

**Architecture:** Flyway 마이그레이션을 vendor 디렉터리(`db/migration/{vendor}`)로 분리 — 기존 V1~V8 은 `postgresql/` 로 이동(체크섬은 내용 기반이라 기존 PG DB 안전), Oracle 은 V1~V8 을 하나로 통합한 `oracle/V1__init.sql` 풀스키마. `oracle` 프로파일은 `ddl-auto: none`(엔티티의 `columnDefinition="text"` 12곳이 Oracle validate 와 충돌 — Flyway 가 스키마 소유). Compose 의 issuer 이중 주소 문제는 issuer-uri(브라우저 관점 localhost:8081) + jwk-set-uri(컨테이너 내부 keycloak:8080) 분리로 해결.

**Tech Stack:** ojdbc11, flyway-database-oracle, gvenzl/oracle-free:23-slim, quay.io/keycloak/keycloak:26.0, eclipse-temurin:21-jre.

## Global Constraints

- UI/주석 텍스트 한국어. KDoc/주석에 `/*` 시퀀스 금지(코틀린 중첩 주석).
- **H2/Postgres 경로 무변경**: h2 프로파일은 flyway 비활성(ddl-auto: update) 그대로, PG 는 vendor 경로가 `postgresql/` 로 자동 해석.
- varchar 는 Oracle 에서 **`varchar2(n char)`**(문자 단위 — 한글 이름/메시지 잘림 방지).
- uuid → `varchar2(36)` + `hibernate.type.preferred_uuid_jdbc_type: CHAR`. text → `clob`. boolean → `number(1)`. bigint → `number(19)`. integer → `number(10)`. timestamptz → `timestamp with time zone`. `DEFAULT now()` → `DEFAULT systimestamp`.
- 백엔드 테스트: `$env:JAVA_HOME="C:\Users\jslim\.jdks\corretto-21.0.10"; ./gradlew :test`.

---

### Task 1: Flyway vendor 분리 + Oracle 의존성 + oracle 프로파일

**Files:**
- Modify: `backend/build.gradle.kts` (ojdbc11·flyway-database-oracle)
- Move: `backend/src/main/resources/db/migration/V1~V8*.sql` → `backend/src/main/resources/db/migration/postgresql/`
- Create: `backend/src/main/resources/db/migration/oracle/V1__init.sql`
- Modify: `backend/src/main/resources/application.yml` (flyway locations `{vendor}`)
- Create: `backend/src/main/resources/application-oracle.yml`

**Interfaces:**
- Produces: `oracle` 스프링 프로파일 — `SPRING_PROFILES_ACTIVE=oracle` + `FLOWLINK_DB_URL=jdbc:oracle:thin:@//host:1521/FREEPDB1` 로 기동(Task 2 compose 가 사용).

- [ ] **Step 1: 의존성 추가**

`backend/build.gradle.kts` 의 Persistence 블록에:

```kotlin
    implementation("org.flywaydb:flyway-database-oracle")
    runtimeOnly("com.oracle.database.jdbc:ojdbc11")
```

- [ ] **Step 2: 마이그레이션 vendor 분리**

```bash
cd backend/src/main/resources/db/migration
mkdir postgresql && git mv V*.sql postgresql/
```

`application.yml` flyway 블록을:

```yaml
  flyway:
    enabled: true
    baseline-on-migrate: true
    locations: classpath:db/migration/{vendor}
```

- [ ] **Step 3: Oracle 통합 스키마 작성**

`backend/src/main/resources/db/migration/oracle/V1__init.sql` — V1~V8 의 **최종 상태**를 Oracle 타입으로 통합(변경 이력 아님):

```sql
-- FlowLink Oracle 풀스키마 — postgresql/V1~V8 의 최종 상태를 통합(신규 Oracle DB 전용).
-- uuid=varchar2(36)+preferred_uuid_jdbc_type CHAR, text=clob, boolean=number(1), timestamptz=timestamp with time zone.

CREATE TABLE flow (
    id              varchar2(36)       PRIMARY KEY,
    tenant_id       varchar2(64 char)  NOT NULL,
    name            varchar2(255 char) NOT NULL,
    description     clob,
    current_version number(10)         DEFAULT 0 NOT NULL,
    archived        number(1)          DEFAULT 0 NOT NULL,
    version         number(19)         DEFAULT 0 NOT NULL,
    folder_id       varchar2(36),
    created_at      timestamp with time zone NOT NULL,
    updated_at      timestamp with time zone NOT NULL
);
CREATE INDEX idx_flow_tenant ON flow (tenant_id, archived);
CREATE INDEX idx_flow_folder ON flow (folder_id);

CREATE TABLE flow_version (
    id          varchar2(36)       PRIMARY KEY,
    flow_id     varchar2(36)       NOT NULL REFERENCES flow (id) ON DELETE CASCADE,
    version_no  number(10)         NOT NULL,
    name        varchar2(255 char) NOT NULL,
    graph_json  clob               NOT NULL,
    note        clob,
    created_by  varchar2(255 char),
    created_at  timestamp with time zone NOT NULL,
    CONSTRAINT uq_flow_version UNIQUE (flow_id, version_no)
);
CREATE INDEX idx_flow_version_flow ON flow_version (flow_id);

CREATE TABLE execution (
    id              varchar2(36)       PRIMARY KEY,
    tenant_id       varchar2(64 char)  NOT NULL,
    flow_id         varchar2(36)       NOT NULL,
    flow_version_id varchar2(36)       NOT NULL,
    status          varchar2(20)       NOT NULL,
    trigger_type    varchar2(20)       NOT NULL,
    triggered_by    varchar2(255 char),
    input_json      clob,
    started_at      timestamp with time zone,
    finished_at     timestamp with time zone,
    error           clob,
    created_at      timestamp with time zone NOT NULL
);
CREATE INDEX idx_execution_tenant ON execution (tenant_id, started_at DESC);
CREATE INDEX idx_execution_flow   ON execution (flow_id, started_at DESC);

CREATE TABLE node_execution (
    id            varchar2(36)       PRIMARY KEY,
    execution_id  varchar2(36)       NOT NULL REFERENCES execution (id) ON DELETE CASCADE,
    node_id       varchar2(64 char)  NOT NULL,
    node_name     varchar2(255 char),
    node_type     varchar2(20),
    seq           number(10)         NOT NULL,
    status        varchar2(20)       NOT NULL,
    http_status   number(10),
    duration_ms   number(19),
    ok            number(1)          DEFAULT 0 NOT NULL,
    request_text  clob,
    response_text clob,
    output_json   clob,
    started_at    timestamp with time zone,
    finished_at   timestamp with time zone
);
CREATE INDEX idx_node_exec_execution ON node_execution (execution_id, seq);

CREATE TABLE folder (
    id          varchar2(36)       PRIMARY KEY,
    tenant_id   varchar2(64 char)  NOT NULL,
    name        varchar2(255 char) NOT NULL,
    parent_id   varchar2(36),
    created_at  timestamp with time zone NOT NULL,
    updated_at  timestamp with time zone NOT NULL
);
CREATE INDEX idx_folder_tenant ON folder (tenant_id);
CREATE INDEX idx_folder_parent ON folder (parent_id);

CREATE TABLE mock_server (
    id          varchar2(36)       PRIMARY KEY,
    tenant_id   varchar2(64 char)  NOT NULL,
    name        varchar2(255 char) NOT NULL,
    slug        varchar2(64)       NOT NULL,
    kind        varchar2(16)       NOT NULL,
    enabled     number(1)          DEFAULT 1 NOT NULL,
    spec_json   clob,
    created_at  timestamp with time zone NOT NULL,
    updated_at  timestamp with time zone NOT NULL,
    CONSTRAINT uq_mock_server_tenant_slug UNIQUE (tenant_id, slug)
);
CREATE INDEX idx_mock_server_tenant ON mock_server (tenant_id);

CREATE TABLE app_setting (
    id            varchar2(36)       PRIMARY KEY,
    tenant_id     varchar2(64 char)  NOT NULL,
    setting_key   varchar2(128)      NOT NULL,
    setting_value clob,
    updated_at    timestamp with time zone NOT NULL,
    CONSTRAINT uq_app_setting UNIQUE (tenant_id, setting_key)
);

CREATE TABLE execution_suspension (
    execution_id     varchar2(36) PRIMARY KEY REFERENCES execution (id) ON DELETE CASCADE,
    tenant_id        varchar2(64 char) NOT NULL,
    pending_node_id  varchar2(80)      NOT NULL,
    run_state        clob              NOT NULL,
    outcome_json     clob,
    wait_deadline    timestamp with time zone,
    updated_at       timestamp with time zone DEFAULT systimestamp NOT NULL
);
CREATE INDEX idx_suspension_deadline ON execution_suspension (wait_deadline);
```

- [ ] **Step 4: oracle 프로파일 작성**

`backend/src/main/resources/application-oracle.yml`:

```yaml
# Oracle 프로파일 — SPRING_PROFILES_ACTIVE=oracle (compose 기본 스택)
# ddl-auto: none — 엔티티 columnDefinition="text"(PG 문법) 12곳이 Oracle validate 와 충돌.
# 스키마 소유권은 Flyway(db/migration/oracle) 단독.
spring:
  datasource:
    url: ${FLOWLINK_DB_URL:jdbc:oracle:thin:@//localhost:1521/FREEPDB1}
    username: ${FLOWLINK_DB_USER:flowlink}
    password: ${FLOWLINK_DB_PASSWORD:flowlink}
  jpa:
    hibernate:
      ddl-auto: none
    properties:
      hibernate.type.preferred_uuid_jdbc_type: CHAR   # uuid → varchar2(36) 문자열 바인딩

flowlink:
  execution:
    ssrf:
      allow-loopback: true   # 내장 mock(/mock/**) 을 앱 자신에게 호출(사설망은 여전히 차단)
```

- [ ] **Step 5: 회귀 확인(단위 + H2 기동 + 컴파일)**

```powershell
$env:JAVA_HOME="C:\Users\jslim\.jdks\corretto-21.0.10"; ./gradlew :test bootJar -x test
```
Expected: 테스트 전부 PASS, flowlink.jar 빌드. H2 dev 기동(`scripts\start.ps1 -H2`) 후 `/actuator/health` UP + 플로우 목록 GET 정상(= flyway locations 변경이 h2/기존 경로에 무영향).

- [ ] **Step 6: Commit**

```bash
git add backend/build.gradle.kts backend/src/main/resources/
git commit -m "feat(db): Flyway vendor 분리(postgresql/) + Oracle 풀스키마·oracle 프로파일(ojdbc11)"
```

⚠ 만약 compose 검증(Task 3)에서 Flyway 가 `Unsupported Database: Oracle 23.x` 로 거부하면 `build.gradle.kts` 에 `ext["flyway.version"] = "10.17.3"` (Boot 관리 버전 override) 를 추가하고 재빌드한다.

---

### Task 2: Dockerfile + docker-compose.yml + seed-mock 토큰 지원

**Files:**
- Create: `deploy/Dockerfile`
- Create: `deploy/docker-compose.yml`
- Modify: `demos/seed-mock.mjs` (`FLOWLINK_TOKEN` Bearer 헤더)

**Interfaces:**
- Consumes: `backend/build/libs/flowlink.jar`(프론트 dist 동봉 — 빌드는 호스트에서 `npm run build` → `gradle bootJar`), `deploy/keycloak/flowlink-realm.json`(P1 — redirect 에 :18080 이미 포함).
- Produces: `docker compose -f deploy/docker-compose.yml up -d` → 앱 :18080 / Keycloak :8081 / Oracle :1521.

- [ ] **Step 1: Dockerfile**

`deploy/Dockerfile`:

```dockerfile
# 실행 전용 이미지 — 빌드는 호스트에서: (frontend) npm run build → (backend) gradle bootJar
# 컨텍스트는 리포 루트: docker compose -f deploy/docker-compose.yml build
FROM eclipse-temurin:21-jre
WORKDIR /app
COPY backend/build/libs/flowlink.jar /app/flowlink.jar
EXPOSE 18080
ENTRYPOINT ["java", "-jar", "/app/flowlink.jar"]
```

- [ ] **Step 2: docker-compose.yml**

`deploy/docker-compose.yml`:

```yaml
# FlowLink 풀스택 — 앱(Oracle 프로파일) + Oracle Free 23ai + Keycloak(OIDC).
#   빌드:  (frontend) npm run build  →  (backend) gradlew bootJar  →  docker compose -f deploy/docker-compose.yml up -d --build
#   접속:  http://localhost:18080 (alice/alice 등 — 비번=아이디)
name: flowlink

services:
  oracle:
    image: gvenzl/oracle-free:23-slim
    container_name: flowlink-oracle
    environment:
      ORACLE_PASSWORD: admin
      APP_USER: flowlink
      APP_USER_PASSWORD: flowlink
    ports:
      - "1521:1521"
    volumes:
      - oracle-data:/opt/oracle/oradata
    healthcheck:
      test: ["CMD", "healthcheck.sh"]
      interval: 10s
      timeout: 5s
      retries: 60

  keycloak:
    image: quay.io/keycloak/keycloak:26.0
    container_name: flowlink-keycloak
    command: ["start-dev", "--import-realm"]
    environment:
      KC_BOOTSTRAP_ADMIN_USERNAME: admin
      KC_BOOTSTRAP_ADMIN_PASSWORD: admin
      # 브라우저(:8081)와 컨테이너 내부(keycloak:8080)가 같은 issuer 를 보도록 고정
      KC_HOSTNAME: http://localhost:8081
      KC_HOSTNAME_BACKCHANNEL_DYNAMIC: "true"
    ports:
      - "8081:8080"
    volumes:
      - ./keycloak:/opt/keycloak/data/import:ro
    healthcheck:
      test: ["CMD-SHELL", "exec 3<>/dev/tcp/127.0.0.1/8080"]
      interval: 5s
      timeout: 3s
      retries: 40

  app:
    build:
      context: ..
      dockerfile: deploy/Dockerfile
    container_name: flowlink-app
    ports:
      - "18080:18080"
    environment:
      SPRING_PROFILES_ACTIVE: oracle
      FLOWLINK_DB_URL: jdbc:oracle:thin:@//oracle:1521/FREEPDB1
      FLOWLINK_DB_USER: flowlink
      FLOWLINK_DB_PASSWORD: flowlink
      # issuer 는 토큰 iss 검증(브라우저 관점 주소), JWKS 는 컨테이너 내부 도달 주소로 분리
      SPRING_SECURITY_OAUTH2_RESOURCESERVER_JWT_ISSUER_URI: http://localhost:8081/realms/flowlink
      SPRING_SECURITY_OAUTH2_RESOURCESERVER_JWT_JWK_SET_URI: http://keycloak:8080/realms/flowlink/protocol/openid-connect/certs
      # RunState 스냅샷 암호키 — 운영에선 반드시 교체
      FLOWLINK_EXECUTION_STATE_SECRET: compose-dev-state-secret-change-me
    depends_on:
      oracle:
        condition: service_healthy
      keycloak:
        condition: service_started

volumes:
  oracle-data:
```

- [ ] **Step 3: seed-mock.mjs 토큰 지원**

`demos/seed-mock.mjs` 의 fetch 헤더에 선택적 Bearer — 상단에:

```javascript
const TOKEN = process.env.FLOWLINK_TOKEN || ''
const AUTH = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}
```

모든 `fetch(...)` 의 `headers` 에 `...AUTH` 스프레드(예: `headers: { 'Content-Type': 'application/json', ...AUTH }`). 사용법 주석 추가: `FLOWLINK_TOKEN=$(토큰) node demos/seed-mock.mjs` (OIDC 스택에선 editor 이상 필요).

- [ ] **Step 4: Commit**

```bash
git add deploy/Dockerfile deploy/docker-compose.yml demos/seed-mock.mjs
git commit -m "feat(deploy): docker-compose 풀스택(app+Oracle Free+Keycloak) + seed-mock 토큰 지원"
```

---

### Task 3: compose 검증(마이그레이션·로그인·RBAC·데모 실행) + 런북

**Files:**
- Modify: `deploy/README.md` (compose 런북 섹션)
- Modify: `CLAUDE.md` (P4 섹션)

- [ ] **Step 1: 빌드 + 기동**

```powershell
cd frontend; npm run build
cd ../backend; $env:JAVA_HOME="C:\Users\jslim\.jdks\corretto-21.0.10"; ./gradlew bootJar -x test
cd ..; docker compose -f deploy/docker-compose.yml up -d --build
```
(먼저 로컬 백엔드 :18080·dev Keycloak :8081 을 내려 포트 충돌 방지: `scripts\stop.ps1`, `docker compose -f deploy/keycloak-dev.compose.yml down`)

Expected: oracle healthy(첫 기동 1~3분) → app 기동 로그에 Flyway `Successfully applied 1 migration` + `Started FlowlinkApplication`.

- [ ] **Step 2: 검증 매트릭스**

1. `GET :18080/actuator/health` → UP.
2. `GET :18080/api/v1/auth/config` → `{enabled:true, issuer:http://localhost:8081/realms/flowlink}`.
3. **RBAC e2e 재사용**: `node e2e/saas-p1-auth.mjs` (Keycloak :8081 + 앱 :18080 전제 그대로) → **27/27 PASS on Oracle**.
4. **데모 실행**: alice 토큰으로 `FLOWLINK_TOKEN=... node demos/seed-mock.mjs` → 플로우 생성(POST /flows + versions: set→http(mock)→assert) → POST run → 폴링 SUCCEEDED (= Oracle 위에서 P2 비동기 실행·suspension 테이블 동작).
5. 브라우저: `http://localhost:18080` → Keycloak 로그인(alice) → 대시보드 로드(단일 jar 서빙 + OIDC).
6. 재기동 내구성(선택): wait 실행 → `docker compose restart app` → WAITING 유지 → 콜백 → SUCCEEDED.

- [ ] **Step 3: 런북 + CLAUDE.md + Commit**

`deploy/README.md` 에 "§ Compose 풀스택(Oracle+Keycloak)" 섹션(빌드 2단계 → up → 유저 표 → 초기화 `down -v`). CLAUDE.md 에 P4 섹션.

```bash
git add deploy/README.md CLAUDE.md
git commit -m "docs: SaaS P4(Oracle·Compose) 런북 + CLAUDE.md 갱신"
```

---

## Self-Review 결과

- **스펙 커버리지(§6)**: ojdbc11+flyway-database-oracle(T1) · vendor 분리+통합 V1(T1) · application-oracle.yml(preferred_uuid_jdbc_type CHAR·ddl-auto none·ssrf allow-loopback)(T1) · H2/PG 무변경(T1 Step5 검증) · compose 3서비스+issuer/jwk 분리(T2) · realm 재사용(P1 산출물) · seed-mock FLOWLINK_TOKEN(T2) · 런북(T3) · 검증 매트릭스 "compose up→마이그레이션→로그인→데모 실행→RBAC"(T3).
- **플레이스홀더 없음**: SQL·yml·Dockerfile·compose 전문 포함.
- **타입 일관성**: Oracle 스키마의 컬럼명·유니크 제약이 postgresql/V1~V8 최종 상태 및 엔티티(@Table/@Column)와 대조 완료(mock_server uq (tenant_id,slug)·flow.version number(19)·folder.parent_id·suspension PK=execution_id).
- 리스크 명시: Flyway 10.10 의 Oracle 23 미지원 가능성 → 버전 override 컨틴전시(T1 말미).
