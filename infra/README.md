# FlowLink 배포 — 앱은 서버(EC2), 지원 인프라는 도커

**구성 요약**

| 무엇 | 어디서 | 어떻게 |
|---|---|---|
| **메인 앱** (flowlink.jar, 화면+API 단일 프로세스 :18080) | EC2 등 실제 서버 | `scripts/start.sh` (Linux) / `scripts/start.ps1` (Windows) |
| **Vault** (시크릿 저장소) | 도커 (`infra/docker-compose.yml`) | `docker compose -f infra/docker-compose.yml up -d` |
| **Oracle** (운영 DB) | 나중에 별도/사내 서버 | 앱 env `FLOWLINK_DB_URL` 로 연결 (DDL 은 Flyway 가 소유) |
| **로그인** | GitHub 계정 (Copilot 과 동일한 디바이스 플로우) | 앱 env `FLOWLINK_AUTH_GITHUB_ENABLED=true` |

프론트(dist)는 **jar 안에 동봉**되어 내장 톰캣이 화면+API 를 한 프로세스로 서빙한다(nginx 불필요).
앱은 도커에 넣지 않는다 — 서버에서 `java -jar` 로 직접 뜨고, 도커엔 앱이 의존하는 Vault 만 상시 띄운다.

---

## 1. 빌드 (개발 PC)

```bash
cd frontend && npm ci && npm run build      # ① dist 생성 (먼저!)
cd ../backend && sh gradlew bootJar          # ② dist 를 jar 에 동봉 → backend/build/libs/flowlink.jar
```
> 순서 중요: **npm run build 를 먼저** 해야 dist 가 jar 에 들어간다.

## 2. 앱 실행 (서버 / 로컬)

리포 루트에서 lifecycle 스크립트로 띄운다(단일 jar 를 백그라운드 실행 + 헬스 대기, PID/로그는 `.run/`).

```bash
# Linux / macOS / Git Bash
bash scripts/start.sh            # 기존 jar 실행 (없으면 안내). 기본 프로파일 h2(로컬 파일 DB)
bash scripts/start.sh --build    # 프론트+백엔드 재빌드 후 실행
bash scripts/status.sh           # PID 생존 + /actuator/health
bash scripts/stop.sh
```
```powershell
# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -File scripts\start.ps1
powershell -ExecutionPolicy Bypass -File scripts\status.ps1
powershell -ExecutionPolicy Bypass -File scripts\stop.ps1
```

**운영(EC2)에서 켜는 것들** — 앱 프로세스 env 로 준다(도커 아님):

```bash
# GitHub 로그인 (Keycloak 대체)
export FLOWLINK_AUTH_GITHUB_ENABLED=true
export FLOWLINK_AUTH_JWT_SECRET=<강한 시크릿>              # 앱 JWT 서명키. 미설정 시 dev 폴백 + WARN
export FLOWLINK_AUTH_ALLOWED_LOGINS=alice,bob             # 선택. 허용 GitHub 로그인 목록(비우면 전체 허용, 기동 시 WARN)

# Vault 시크릿 끌어오기
export FLOWLINK_VAULT_ENABLED=true
export FLOWLINK_VAULT_ADDRESS=http://<vault호스트>:8200
export FLOWLINK_VAULT_TOKEN=<Vault 토큰>

# 운영 DB(Oracle) — 나중에 붙일 때
export SPRING_PROFILES_ACTIVE=oracle
export FLOWLINK_DB_URL='jdbc:oracle:thin:@//<oracle호스트>:1521/FREEPDB1'
export FLOWLINK_DB_USER=flowlink FLOWLINK_DB_PASSWORD=<...>

bash scripts/start.sh
```
- **콜백 수신 주소는 자동** — wait(콜백 대기) 수신 URL 의 밑둥은 기본적으로 **접속한 주소(오리진)** 를 쓴다.
  다른 주소로 받아야 하면 화면 ⚙ 설정에 저장하거나 env `FLOWLINK_EXECUTION_RELAY_BASEURL`.
- 로컬 개발 기본은 h2 프로파일(H2 파일 DB + SSRF allow-loopback + 인증 없음) — env 를 안 주면 이 모드.

## 3. GitHub 로그인 (운영 인증)

Keycloak/OIDC 대신 **GitHub 계정으로 로그인**한다(어시스턴트 Copilot 연결과 동일한 device flow).
로그인하면 앱이 자체 JWT(HMAC)를 발급하고 그 JWT 를 검증 → 인증 필수 + 팀(tenant) 격리.

1. 앱을 `FLOWLINK_AUTH_GITHUB_ENABLED=true` + `FLOWLINK_AUTH_JWT_SECRET=<시크릿>` 으로 기동.
2. 브라우저로 접속 → **GitHub 로 로그인** 버튼 → 표시된 코드로 github.com/login/device 인증 → 자동 로그인.
3. (선택) `FLOWLINK_AUTH_ALLOWED_LOGINS` 로 허용 계정을 제한(비우면 전체 허용). ⚠ github 모드는 `jwt-secret` 이 없으면 기동 실패(토큰 위조 방지).
- 미설정(기본)이면 dev 모드(로그인 없음, permitAll) — 로컬 개발용.
- 표준 OIDC IdP(Auth0/Entra/Keycloak)를 쓰고 싶으면 `application.yml` 의 issuer-uri 를 설정하면 그쪽으로 동작(코드 IdP 비종속).

## 4. Vault 인프라 (도커)

앱이 시크릿을 끌어오는 저장소. dev 모드 Vault 를 도커로 띄운다.

```bash
docker compose -f infra/docker-compose.yml up -d          # Vault(:8200) 기동
# 시크릿 넣기 (KV v2, secret/ 마운트)
docker exec -e VAULT_ADDR=http://127.0.0.1:8200 -e VAULT_TOKEN=flowlink-root \
  flowlink-vault vault kv put secret/flowlink API_TOKEN=s3cr3t DB_PASS=...
docker compose -f infra/docker-compose.yml down -v         # 초기화
```
- 앱은 위 2번의 `FLOWLINK_VAULT_*` env 로 붙는다 → Vault 키가 **시크릿 볼트에 오버레이**(공통 기본층, DB 시크릿이 덮어씀).
  워크플로에서 `{{ 이름@secret }}` 로 참조(바인딩 피커에 `Vault` 배지, 읽기전용). 실행 로그는 값 마스킹(••••••).
- `secret/flowlink` 경로·`secret` 마운트는 `FLOWLINK_VAULT_PATH`·`FLOWLINK_VAULT_MOUNT` 로 변경.
- ⚠ dev 모드 Vault 는 인메모리(재시작 시 초기화). 운영은 파일/통합 스토리지 + unseal 구성으로 교체.

## 5. Oracle (나중에 연결)

운영 DB 는 사내/별도 서버 Oracle 에 붙인다 — 앱 env 의 `FLOWLINK_DB_URL` 만 그쪽으로 바꾸면 되고,
스키마는 **Flyway 가 자동 생성**한다(`backend/src/main/resources/db/migration/oracle`).

로컬에서 Oracle 을 테스트하려면(선택):
```bash
docker compose -f infra/docker-compose.yml --profile oracle up -d   # 로컬 Oracle Free(:1521)
# 앱: SPRING_PROFILES_ACTIVE=oracle FLOWLINK_DB_URL=jdbc:oracle:thin:@//localhost:1521/FREEPDB1 bash scripts/start.sh
```

## 6. 확인 (스모크 체크)

1. `http://서버IP:18080/` → 대시보드(인증 모드면 GitHub 로그인 화면)
2. 워크플로 열고 **새로고침**(`/flows/{id}`) → 404 없이 뜬다 (SPA fallback)
3. 플로우 하나 실행 → SUCCEEDED
4. wait 노드 실행 → 수신 URL 이 `http://서버IP:18080/relay/...` → 다른 PC 에서 그 URL 로 `curl -X POST` → 재개
5. (Vault) 시크릿 볼트에 `Vault` 배지 시크릿이 보이고 `{{ 이름@secret }}` 실행이 값을 씀

## 7. 운영

| 작업 | 방법 |
|---|---|
| 업데이트 | 새 jar 빌드 → `scripts/stop.sh` → 교체 → `scripts/start.sh` |
| 로그 | `tail -f .run/flowlink.log` (또는 `FLOWLINK_HOME` 지정 시 그 경로) |
| 백업(h2) | 종료 후 H2 `.mv.db` 파일 복사 |
| 플러그인 추가 | UI/API 업로드(즉시 반영) 또는 `plugins/` 에 JAR 두고 재시작 |

> 서버(EC2)에 SSH 접속·개발 흐름은 [SERVER-DEVELOPMENT.md](SERVER-DEVELOPMENT.md), 로컬 터널은 [connect-local.ps1](connect-local.ps1).
