# SaaS P2 — 내구 비동기 실행 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline). Steps use checkbox 문법.

**Goal:** POST 실행이 즉시 반환(비동기)되고, 재개 상태(suspension)가 DB 에 영속되어 서버 재시작·배포에도 wait/client/input 실행이 살아남는다.

**Architecture:** RunState 를 JSON 스냅샷(AES-GCM 암호화)으로 `execution_suspension` 테이블에 저장. graph 는 flowVersionId 재파싱으로 재구성. 이중 재개 방지는 **조건부 DELETE 영향행수 = claim 승자** 규약. 인메모리 맵은 라이브 캐시(future/RunState)로 유지하되 진실원은 DB. 실행·재개·콜백 연속 실행은 전용 스레드풀.

**Tech Stack:** ThreadPoolTaskExecutor, Jackson, javax.crypto(AES-GCM), Spring Data JPA.

## Global Constraints
- 노드 단위 즉시 기록(NodeRecorder)·redaction 정책 불변 — 실행 경과 애니메이션 의존.
- `GET /executions/{id}` 는 WAITING 중 pending 명세 반환 계약 유지(재시작 후에도 — DB outcome).
- TenantContext 는 워커에서 수동 set/clear(try-finally). RelayBaseResolver.resolve() 는 **요청 스레드에서만**(캡처 후 전달).
- dev(H2)·기존 e2e 무회귀. resume 멱등(서스펜션 없으면 현재 상태 반환) 유지.

### Task 1: ExecutionContext snapshot/restore + RunStateSnapshot/rehydrate (TDD)
**Files:** engine/ExecutionContext.kt(+snapshotValues/snapshotSeeds/restore), engine/RunStateSnapshot.kt(신규), engine/FlowExecutor.kt(+snapshot()/rehydrate()), test RunStateSnapshotTest.kt
**Interfaces:** `FlowExecutor.snapshot(st: RunState): RunStateSnapshot` / `FlowExecutor.rehydrate(graphJson: String, snap: RunStateSnapshot): RunState`. Snapshot = {activeIds:List, ctxValues:List<Pair→[key,value] 순서보존 리스트>, ctxSeeds, index, seq, pendingNodeId, pendingForm, relayBase, relayRunId}.
- [ ] 테스트: wait 그래프 newRun→drive→중단 상태 스냅샷→Jackson 라운드트립→rehydrate→ctx 값/순서/seeds/active/index 동일 + resume 계속 가능
- [ ] 구현 → `:test` PASS → commit

### Task 2: StateCrypto AES-GCM (TDD)
**Files:** execution/engine/StateCrypto.kt(신규), ExecutionProperties(+stateSecret), test StateCryptoTest.kt
**Interfaces:** `StateCrypto(secret: String).encrypt(plain: String): String`(base64 iv+ct) / `decrypt(b64: String): String`. 키 = SHA-256(secret). 미설정 시 dev 고정키 + `isDevKey` 플래그(OIDC 모드 기동 시 WARN 은 Service 에서).
- [ ] 라운드트립·변조 실패·다른 키 실패 테스트 → 구현 → PASS → commit

### Task 3: ExecutionSuspension 엔티티 + V8 + claim 리포지토리
**Files:** core/domain/ExecutionSuspension.kt, core/repository/ExecutionSuspensionRepository.kt, db/migration/V8__execution_suspension.sql
**Interfaces:** 테이블 execution_suspension(execution_id PK, tenant_id, pending_node_id, run_state text(암호문), outcome_json text, wait_deadline timestamptz?, updated_at). Repo: `@Modifying deleteByExecutionIdAndPendingNodeId(execId, nodeId): Int`(claim), findByExecutionId, findAll.
- [ ] 작성 → 컴파일 → commit

### Task 4: ExecutionService 비동기 + 내구화 (핵심)
**Files:** execution/ExecutionService.kt(대개편), execution/config/ExecutionProperties.kt(+worker pool size/queue), common/error(429 예외 필요 시)
- run(): Execution(RUNNING) 저장 + tenant/user/relayBase/graphJson **요청 스레드 캡처** → 풀 제출(RejectedExecutionException→429) → 즉시 detail 반환
- 워커 공통 `runWorker(execId, tenant, fn)`: TenantContext set/clear + 예외 시 markFailed
- rememberIfPending → `persistSuspension`(스냅샷→암호화→row upsert + 인메모리 캐시 + wait 면 deadline 저장·스케줄)
- `claim(execId, nodeId): ClaimedState?` — row 조회→pendingNodeId 일치→조건부 DELETE 영향행수 1 이면 승자. 인메모리 캐시 회수(future cancel), 캐시 미스면 **rehydrate**(execution→flowVersion graphJson + 복호화 스냅샷)
- resume()/recordWaitCallback()/onWaitTimeout() 전부 claim 경유. resume 은 claim 후 **연속 실행을 풀에 제출**하고 현재 상태 즉시 반환(콜백 ACK 도 즉시). 멱등: claim 실패(=이미 재개/종료) 시 현재 상태/OK 반환
- get(): 인메모리 outcome 우선, 미스면 DB outcome_json
- `@EventListener(ApplicationReadyEvent)` recover(): ①suspension 있는 WAITING → deadline 재무장(경과분 즉시 타임아웃) ②suspension 없는 RUNNING/WAITING 고아 → markFailed("서버 재시작으로 중단")
- [ ] 구현 → 단위 전체 PASS → commit

### Task 5: 프론트 실행 루프 재구성 (Editor.tsx)
- onRun: POST 즉시 응답(id) → **외부 드라이버 = pending·terminal 까지 GET 폴링**(0.4s, WAITING 1.5s) → pendingInput/Form/Client 처리 후 resume(즉시 반환) → 폴링 계속. pendingWait 는 폴링 유지. ⏹ = resume(aborted). watchRunProgress 의 baseline 발견 해크 제거(detail.id 직접).
- [ ] 구현 → build/lint → commit

### Task 6: e2e (`e2e/saas-p2-durable.mjs`)
- ①비동기: POST 응답 즉시 RUNNING(느린 mock 지연 라우트) → 폴링으로 SUCCEEDED ②wait 콜백 자동 재개(폴링 관찰) ③**재시작 내구성**: wait(타임아웃 300s) 진입 → 백엔드 재시작 → 콜백 → SUCCEEDED + 숫자 비교 IF 다운스트림 정상 ④재시작 후 타임아웃 재무장(deadline 5s, 재시작, FAILED 확인) ⑤고아 RUNNING reconcile ⑥resume 멱등 ⑦input 노드 재개(API로 formValues) ⑧⏹ aborted→CANCELLED
- [ ] 작성·실행 전부 PASS → 기존 e2e/saas-p1-auth.mjs 무회귀(OIDC 모드) → commit

### Task 7: 브라우저 검증 + 문서화
- [ ] dev 모드에서 demo 워크플로(wait 포함) 에디터 실행 — 애니메이션·대기 배너·자동 재개 확인
- [ ] CLAUDE.md P2 요약 추가 → commit

## Self-Review
- 스펙 §4.1(스냅샷·암호화·CAS)→T1-4, §4.2(비동기·복구·429)→T4, §4.3(프론트)→T5, 검증→T6-7. 시크릿 평문→T2 암호화. 숫자 타입 라운드트립→T6③.
