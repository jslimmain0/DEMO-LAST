# Flowlink Backend (Spring Boot)

프로토타입 `FlowBuilder.dc.html`(클라이언트사이드 워크플로 빌더)을 **Spring Boot 기반 엔터프라이즈 워크플로
오케스트레이션 플랫폼**으로 고도화하는 백엔드입니다. 1단계(Phase 1)는 **모듈러 모놀리스(단일 배포)**로
시작하며, 패키지 경계로 향후 물리 모듈/워커 분리를 대비합니다.

> 이 코드는 A/B/C/D 멀티에이전트 설계 토론과 병행해 작성된 **저후회(low-regret) 기반**입니다.
> 토론이 끝나면 그 합의 결론(특히 Build vs Buy, 비동기/내구성 실행)을 다음 Phase에 반영합니다.

---

## 무엇이 들어있나 (Phase 1 구현 범위)

| 영역 | 상태 | 비고 |
|---|---|---|
| 워크플로 정의 CRUD + **불변 버전관리** | ✅ | `jsonb` 로 그래프 저장, 프로토타입 export 무손실 호환 |
| 프로토타입 JSON **import/export** | ✅ | `{version,name,nodes,edges}` 라운드트립 |
| **서버사이드 실행 엔진** (DAG) | ✅ | 위상정렬, IF 분기, 첫 실패 중단 |
| HTTP 노드 (RestClient) | ✅ | 연결/읽기 타임아웃, 응답 크기 제한 |
| **SSRF 가드** | ✅ | 사설/루프백/링크로컬/메타데이터 대역 차단 |
| **IF 표현식 샌드박스** | ✅ | `new Function()` → SpEL `SimpleEvaluationContext`(읽기전용) |
| SET(변수, 시크릿 마스킹) / WAIT(휴먼태스크) | ✅(WAIT는 일시중단까지) | 내구성 재개는 Phase 2 |
| 실행 이력/노드 로그 영속화 | ✅ | 감사/재현 기반 |
| 관측성(actuator + Prometheus) | ✅ | `/actuator/prometheus` |
| OpenAPI(Swagger UI) | ✅ | `/swagger-ui.html` |
| 인증(OIDC 리소스서버 골격) + JWT→TenantContext | ✅(조건부) | `issuer-uri` 설정 시 자동 활성, 미설정 시 dev permitAll. 어떤 OIDC IdP와도 호환 |
| redaction deny-by-default(실행로그) | ✅ | HTTP req/res 본문 기본 미저장(`flowlink.execution.capture` 로 옵트인) |
| IF 표현식 종료성 가드 | ✅ | 길이·토큰 수 상한(CEL/하드 타임아웃은 후속) |
| 낙관적 잠금(동시 편집 409) | ✅ | `Flow.@Version` + 409 매핑 |
| RBAC·RLS 행격리·시크릿 볼트 | ⛔ | **타깃 시장 확정 후** Phase 0.5 |
| 비동기 큐/워커·내구성 실행·재시도 | ⛔ | Phase 1 (현재 동기 실행) |
| 트리거(cron/webhook/event) | ⛔ | Phase 1.5 |
| SSRF connect-time IP pinning | ⛔ | 현재 check-time(DNS 리바인딩 갭) — Phase 0.5 |

---

## 사전 요구사항 (현재 이 PC엔 미설치)

- **JDK 21** (Temurin 권장)
- **Docker** (로컬 Postgres 용) 또는 별도 PostgreSQL 16
- Gradle은 **불필요** — 동봉된 `./gradlew` 래퍼가 자동 설치

### 설치 (Windows / PowerShell)

```powershell
winget install EclipseAdoptium.Temurin.21.JDK     # JDK 21
winget install Docker.DockerDesktop                # Docker (또는 로컬 Postgres 직접 준비)
```

설치 후 새 터미널에서 `java -version` 으로 21 확인.

---

## 실행

### 인프라 없이 즉시 실행 (H2 파일·영속) ★Postgres/Docker 불필요

```powershell
# Windows — backend 디렉토리에서
powershell -ExecutionPolicy Bypass -File scripts\start.ps1 -H2
```
```bash
# Git Bash / Linux / macOS
bash scripts/start.sh --h2
```
JDK 를 `~/.jdks` 에서 자동 감지 → 빌드 → H2 **파일**로 기동(Flyway off, Hibernate `ddl-auto: update`).
`READY ✓` 후 `http://localhost:18080/swagger-ui.html`. **데이터는 재시작해도 보존**됩니다
(기본 `~/flowlink-h2db/flowlink.mv.db`, 변경: `FLOWLINK_H2_FILE`, 초기화: 그 파일 삭제).
> 검증됨: `GET/POST /api/v1/flows` 라운드트립 성공(워크플로 생성→v1→조회).

### 가장 쉬운 방법 — 시작/종료 스크립트 (DB + 앱 한 번에)

```powershell
# Windows (PowerShell) — backend 디렉토리에서
powershell -ExecutionPolicy Bypass -File scripts\start.ps1   # Postgres 기동 + (없으면)빌드 + 백그라운드 실행 + 헬스 대기
powershell -ExecutionPolicy Bypass -File scripts\stop.ps1    # 앱 + Postgres 정지(데이터 보존)
```
```bash
# Git Bash / Linux / macOS — backend 디렉토리에서
bash scripts/start.sh      # bash scripts/start.sh --build | --no-db | -f(포그라운드)
bash scripts/stop.sh       # bash scripts/stop.sh --keep-db | --remove-db
```
- 백그라운드 PID/로그: `backend/.run/` (`flowlink.pid`, `flowlink.out.log` / `flowlink.err.log`, bash는 `flowlink.log`)
- 시작 스크립트는 `http://localhost:18080/actuator/health` 가 UP 될 때까지 대기 후 `READY` 출력.

### 수동 실행

```powershell
docker compose up -d                 # 1) DB
./gradlew bootRun                    # 2) 앱 (Windows: .\gradlew.bat bootRun)
#   Swagger UI : http://localhost:18080/swagger-ui.html
#   Health     : http://localhost:18080/actuator/health
```

DB 접속 정보는 환경변수로 덮어쓸 수 있습니다(`FLOWLINK_DB_URL`, `FLOWLINK_DB_USER`, `FLOWLINK_DB_PASSWORD`).

### 테스트

```powershell
$env:JAVA_HOME="C:\Users\jslim\.jdks\corretto-21.0.10"   # PATH에 java가 없으면 필요
./gradlew test
```

표현식 샌드박스/토큰 해석/SSRF 가드는 **DB·Docker 없이** 도는 순수 단위 테스트(15개)로 포함돼 있습니다.
(전체 통합 테스트용 Testcontainers 는 Docker 필요)

> **검증됨**: Corretto 21 로 메인 65클래스 컴파일 + 단위테스트 15개 통과, 부팅 jar(`flowlink.jar`) 생성 확인.

> ⚠️ **Windows + 한글 경로 주의**: 현재 프로젝트 경로(`...워크플로 시스템...`)에 한글/공백이 있어
> `gradlew test` 의 포크된 테스트 워커가 클래스패스를 cp949 로 잘못 디코딩해 `ClassNotFoundException` 이 납니다
> (Gradle 알려진 한계). **앱 빌드/실행(`bootJar`·`bootRun`·`java -jar`)은 영향 없습니다.**
> 테스트만 실행하려면 둘 중 하나:
> 1. ASCII 경로 정션에서 실행 — `cmd /c mklink /J C:\flowlink-build "%CD%\..\.."` 후 `C:\flowlink-build\backend` 에서 `gradlew test`
> 2. (권장) 프로젝트를 ASCII 경로로 이동(예: `C:\projects\flowlink`)

---

## API 요약

베이스: `/api/v1`

### 정의(Definition)
| 메서드 | 경로 | 설명 |
|---|---|---|
| `GET` | `/flows` | 워크플로 목록 |
| `POST` | `/flows` | 생성(빈 v1 자동 생성) |
| `GET` | `/flows/{id}` | 상세(현재 버전 그래프 포함) |
| `PATCH` | `/flows/{id}` | 이름/설명 수정 |
| `DELETE` | `/flows/{id}` | 보관(archive) |
| `POST` | `/flows/{id}/versions` | 새 버전 저장(불변) |
| `GET` | `/flows/{id}/versions` | 버전 목록 |
| `GET` | `/flows/{id}/versions/{no}` | 특정 버전 그래프 |
| `POST` | `/flows/import` | 프로토타입 JSON 가져오기 |
| `GET` | `/flows/{id}/export` | 프로토타입 JSON 내보내기 |

### 실행(Execution)
| 메서드 | 경로 | 설명 |
|---|---|---|
| `POST` | `/flows/{flowId}/runs` | 실행(동기). body: `{ "input": {...}, "versionNo": 3 }`(선택) |
| `GET` | `/flows/{flowId}/runs` | 해당 워크플로 실행 이력 |
| `GET` | `/executions/{id}` | 실행 상세(노드별 req/res 로그) |
| `GET` | `/executions` | 최근 실행 이력 |

---

## 패키지 구조 (모듈 경계)

```
com.flowlink
├─ core/          # 도메인 모델·그래프 모델·리포지토리 (다른 모듈이 의존)
│  ├─ domain      # Flow, FlowVersion, Execution, NodeExecution, enums
│  ├─ graph       # FlowGraph/GraphNode/...  + GraphValidator (프로토타입 JSON 매핑)
│  └─ repository
├─ definition/    # 정의 CRUD/버전/import·export API
├─ execution/     # 실행 엔진 + 실행 API
│  ├─ engine      # FlowExecutor, HttpNodeExecutor, TokenResolver, ExpressionEvaluator, SsrfGuard
│  └─ config      # ExecutionProperties, HttpClientConfig
├─ mock/          # 내장 Mock 서버 — /mock/{slug}/** 게이트웨이 + 라우트 런타임 + 콜백 디스패처 (V4)
├─ security/      # SecurityConfig (Phase 1: permitAll)
└─ common/        # error, json, tenant, openapi
```

향후: `core/definition/execution/trigger/security` 를 물리 Gradle 모듈로 분리하고,
실행을 `flowlink-worker` 로 떼어 별도 배포(egress 격리)할 수 있도록 `settings.gradle.kts` 에 분리 가이드를 남겨두었습니다.

---

## 알려진 한계 / 다음 단계 (Phase 2+)

1. **비동기 + 내구성 실행**: 현재 동기(호출 스레드 점유). 큐(예: Postgres outbox/SQS/Kafka) + 워커로
   전환하고, 장기실행/WAIT 재개·재시도·멱등성을 갖춘 durable execution 도입. (Build vs Buy — Temporal/Camunda
   채택 여부는 설계 토론 결론 반영)
2. **보안**: OIDC/SSO 로그인, RBAC, 테넌트 격리(JWT claim → `TenantContext`, 행 수준 보안), 시크릿 볼트 연동.
3. **트리거**: cron/webhook/event + 중복실행 방지.
4. **DNS 리바인딩** 대응(IP pinning) 및 egress 프록시.
5. **동시성 제어**: 버전 저장 낙관적 락, 실행 동시성 한도.
```
