# Mock 서버 기능(내장) + 검증(assert) 노드 — 설계 (2026-07-04)

> **status: 일부 폐기(partially-retracted)** · 현행 진실원은 [CLAUDE.md](../../../CLAUDE.md).
> 커스텀 빌더(§1~3)·검증 노드(§6)·게이트웨이는 as-built. **§4(PG 프리셋)·§7(demos/pg 시나리오)·§1의 `kind(CUSTOM|PG)`·§8~9의 PG 문구는 폐기**(아래 개정 노트 참조) — 이력 보존용으로 남긴다.

> **개정 (2026-07-04, 같은 날 오후)**: 사용자 피드백으로 **PG 프리셋(상태 있는 가짜 결제 게이트웨이)을 제거**했다.
> "Mock 서버는 상태 관리까지 원한 게 아니라 웹페이지가 뜨고 콜백하는 작업의 mock 이 필요했던 것"이라는 지적 반영.
> 범용 도구에 특정 도메인(결제)을 하드코딩한 게 어색했다. 아래 §4(PG 프리셋)·§7(PG 시나리오 14종)은 **폐기**되고,
> "결제창(HTML)+콜백"은 §3의 커스텀 라우트(HTML 응답 + 콜백 발사)만으로 재현한다([demos/pay-mock](../../../demos/pay-mock/README.md)).
> 커스텀 빌더(§1~3)·검증 노드(§6)·게이트웨이는 그대로 유지. `MockServer.Kind` 는 CUSTOM 하나만 남김(향후 프리셋 확장 여지).

## 배경 · 결정

- 사용자 요구(3연속 메시지로 구체화): ① "mock 서버들을 쉽게 만들 수 있는 기능" ② PG 결제 테스트
  시나리오 30종 목록(A 정상결제 / B 서버간 / C 콜백·노티 / D 이상계 / E 규격·인코딩 / F 변환 활용)
  ③ "실패가 정답인 검증(음성 테스트)은 제외" ④ **"워크플로 기능이 있고, Mock 서버 기능이 '또' 있는 것"**
  — 즉 별도 스크립트가 아니라 **FlowLink 안의 1급 기능**.
- 확인 질문(실행 방식 / v1 범위 / 구성) 3회 모두 60초 무응답 → 권장안으로 진행:
  **백엔드 내장 서빙** + **커스텀 라우트 빌더와 '가짜 PG' 프리셋 둘 다**.
- 시나리오 목록은 mock 기능의 요구 수준으로 반영: 부분취소 잔액·빌키·가상계좌 입금노티처럼
  **상태**가 필요한 것은 커스텀 규칙으로 표현 불가 → 상태 있는 **PG 프리셋**을 내장해 커버.
- 시나리오의 `assert:` 판정을 위해 **검증(assert) 노드**를 신설(거짓이면 실행 FAILED).
- 직전에 만든 `mock-server.js`/demos 01~06 은 그대로 유지(회귀 대상). PG 시나리오는 내장 기능을 쓴다.

## 1. 도메인 · 저장

- `core/domain/MockServer` (Flow 패턴 준용): `id(UUID)`, `tenant_id`, `name`, `slug`(**전역 유니크**,
  `[a-z0-9-]{3,40}` — 서빙 URL 경로), `kind`(`CUSTOM` | `PG`), `enabled`, `spec_json`(text),
  `created_at/updated_at`. 낙관적 락은 생략(라우트 편집 충돌은 last-write-wins — 플로우와 달리 위험도 낮음).
- `V4__mock_server.sql`(Postgres/Flyway) + H2 는 `ddl-auto: update` 로 자동.
- `spec_json`: CUSTOM 은 `{ routes: MockRoute[] }`, PG 는 `{ secret?: string }`(서명 검증용, 기본 `demo-secret`).

```ts
MockRoute { id, method: 'GET'|'POST'|…|'ANY', path: '/users/{id}', rules: MockRule[] }
MockRule  { id, when?: MockCond[],            // 모두 만족(AND). 없으면 항상 매칭(기본 규칙)
            status: number, contentType: 'json'|'text'|'html'|'xml'|mime,
            charset?: 'UTF-8'|'EUC-KR'|'MS949', headers?: {key,value}[],
            body?: string,                    // 템플릿
            delayMs?: number,                 // cap 10_000
            callback?: { afterMs, url, method, contentType, body, retryUntilOk } } // url·body 템플릿
MockCond  { source: 'query'|'header'|'body'|'path', key, op: 'eq'|'ne'|'exists'|'contains', value? }
```

## 2. 서빙 게이트웨이 (`/mock/{slug}/**`)

- 전 HTTP 메서드 캐치올. **permitAll**(`PUBLIC_PATHS` 에 `/mock/**`) + **CORS 전면 오픈**
  (클라이언트 모드 노드가 브라우저에서 직접 호출) + OPTIONS 204.
- slug 미존재/`enabled=false` → 404 JSON. `GET /mock/{slug}/__routes` → 라우트 요약(디버그).
- 요청 본문은 Content-Type 의 charset 으로 디코딩(기본 UTF-8) — Java 는 EUC-KR/MS949 네이티브.
- 테넌트: 서빙은 무인증(외부 시스템·게이트웨이 흉내이므로). 관리 API 만 테넌트 스코프.

## 3. 커스텀 런타임 (`MockRuntime` — 순수 로직, 단위테스트 대상)

- **매칭**: 정의 순서대로 method(ANY 허용)+경로 세그먼트 비교(`{param}` 세그먼트는 임의 값 매칭) 첫 라우트.
  라우트 안에서는 조건(when) 모두 만족하는 첫 규칙, 없으면 무조건 규칙, 그것도 없으면 404.
- **템플릿**(응답 body·headers·callback url/body): `{{path.x}}` `{{query.x}}` `{{header.x}}`
  `{{body.x}}`(JSON 최상위 키 또는 urlencoded 필드) `{{body}}`(원문) `{{method}}` `{{uuid}}`
  `{{seq}}`(서버별 증가 카운터) `{{now}}`(ISO). 미해석 토큰은 빈 문자열.
  (워크플로 바인딩 `{{ key@node }}` 와는 **다른 문맥** — UI 도움말로 구분 안내)
- **응답 charset**: 선택 charset 으로 바이트 인코딩 + Content-Type 에 명시(레거시 시나리오 E 커버).
- **콜백 발사**: 응답 전송 후 `afterMs`(cap 60s) 뒤 템플릿 해석된 URL 로 발사(승인노티/입금노티 패턴).
  응답 본문이 `OK` 가 아니면 2초 간격 최대 3회 재발송(`retryUntilOk`) — 시나리오 14 규약.
  발사 대상 URL 은 **SsrfGuard 검사**(로컬 프로파일은 loopback 허용 — relay 콜백 가능).

## 4. PG 프리셋 (`MockPgSimulator` — 서버 ID 별 인메모리 상태) — ⚠ 폐기됨(retracted)

`kind=PG` 서버는 라우트 편집 대신 고정 엔드포인트 세트(아래)를 서빙. 상태(원장·빌키·가상계좌)는
ConcurrentHashMap — 재시작 시 소실(문서화). 금액은 **문자열**로 응답(assert 비교 단순화).
모든 성공 응답 `resultCode:'0000'`, 오류는 4xx + 코드(구현은 하되 음성 데모는 없음 — 사용자 지시).

| 엔드포인트 | 동작 |
|---|---|
| `POST/GET /auth` | **결제창 HTML**(form 노드 팝업 대상): mid·orderId·productName·amount·returnUrl 수신, [인증하기] → `/auth/confirm` → authToken 발급 후 **returnUrl 로 자동 POST 브리지** `{resultCode,authToken,orderId,amount}` |
| `POST /approve` | 인증결제 승인: `{mid,authToken,amount,notiUrl?}` — 토큰 검증(단일사용)·금액 일치 검증 → TID 발급·원장 기록 → 승인노티 발사 → `{resultCode,tid,orderId,amount,approvedAt}` |
| `POST /keyin` | 수기(키인) 승인: `{mid,cardNo,expiry,amount,sign?,notiUrl?}` — sign 있으면 `sha256hex(mid+amount+secret)` 검증 |
| `POST /billkey` | 빌키 발급 `{mid,cardNo,expiry}` → `{billKey}` |
| `POST /billkey/approve` | 빌키 승인 `{mid,billKey,amount,orderId,notiUrl?}` (빌키 존재 검증) |
| `POST /billkey/delete` | 빌키 삭제 |
| `POST /cancel` | 취소 `{tid,amount?,notiUrl?}` — 생략=전액, 부분취소 잔액 관리 → `{resultCode,cancelTid,cancelAmt,remainAmt}` + 취소노티 발사 |
| `GET /tx?tid=` | 거래조회 `{tid,orderId,amount,remainAmt,status}` — 노티 대사(시나리오 11) |
| `POST /va` | 가상계좌 채번 `{mid,orderId,amount,notiUrl,autoDepositSec?}` → `{acctNo,bankName}` + n초 뒤 자동입금·**입금노티** 발사(cap 60s) |
| `GET /va/status?acctNo=` | 입금 여부 조회 |
| `POST /legacy/euckr` | EUC-KR urlencoded 왕복(`custName=홍길동`) |
| `POST /legacy/949` | 수신 Content-Type 을 응답 필드로 에코(`recvContentType`) — MS949/windows-949 부착 확인 |
| `GET /legacy/xml` | XML PG 응답 `{resultCode,tid}` |
| `POST /legacy/urlenc` | urlencoded 응답(`tid` 포함) |
| `POST /legacy/raw` | 고정 전문 `CANCEL\|{tid}\|{amount}` 파싱 → 텍스트 `OK\|{tid}\|CANCELLED` |
| `GET /legacy/text` | 구형 텍스트 응답 `RESULT:OK APPROVAL_NO:12345678 …` (regex-extract 대상) |
| `POST /legacy/confirm` | `{apprNo}` 에코 — 추출값 재사용 검증용 |
| `GET /secure` | `Authorization: Basic demo:demo1234` 필수 → `{resultCode:'0000'}` |

노티(승인/취소/입금) 공통: notiUrl 로 urlencoded POST, `OK` 응답 아니면 2초 간격 3회 재발송.

## 5. 관리 API + 프론트 UI

- `/api/v1/mock-servers`: GET 목록 / POST 생성(name·slug·kind) / GET·PUT(spec)·PATCH(enabled)·DELETE.
  테넌트 스코프(`findByIdAndTenantId`), slug 전역 유니크 충돌 409.
- 프론트: `/mocks` 목록(카드: 이름·slug·kind·enabled 토글·base URL 복사·삭제), `/mocks/:id` 편집기.
  - CUSTOM: 라우트 목록(method 배지+경로, 위/아래 이동) + 규칙 편집(조건 행·status·contentType·charset·
    본문 템플릿 textarea(토큰 도움말)·지연·콜백 발사 섹션). 저장 버튼(전체 spec PUT).
  - PG: 엔드포인트 표 + secret 설정 + "워크플로에서 쓰는 법" 안내(base URL 복사).
  - Dashboard 상단 내비에 **Mock 서버** 링크(플로우/실행 이력과 나란히).

## 6. 검증(assert) 노드

- `NodeType.ASSERT`(`"assert"`), 설정은 IF 와 동일한 `condition`(SpEL + `{{ 토큰 }}`).
- 참 → 성공(출력 `{result:true}`), 거짓/평가불가 → **노드 실패**("⚠ 검증 실패: …") → 실행 FAILED
  (기존 first-failure 규약). IF 처럼 분기하지 않고 단일 out.
- 프론트: 팔레트 "검증"(✔), PropertyPanel 조건 편집(IF 섹션 패턴 재사용), cat 색 토큰.

## 7. demos/pg 시나리오 (정상계만 — 대상: PG 프리셋 slug `pg-demo`) — ⚠ 폐기됨(retracted)

base URL `http://localhost:18080/mock/pg-demo`. 사용자 목록 매핑(음성 5·9·13·16~20·22 제외,
21 망취소는 "오류 응답 허용 판정" 노드 규칙이 없어 후속):

| 파일 | 원 시나리오 | 흐름 |
|---|---|---|
| pg-01 카드결제 풀코스 | 1·11·15 | SET → FORM(/auth) → WAIT(인증, **HTML 응답**) → ASSERT 0000 → HTTP(/approve, notiUrl=wait2) → ASSERT → WAIT(승인노티) → ASSERT(노티 tid == 승인 tid) |
| pg-02 승인→전체취소 | 2·6 | HTTP(keyin) → ASSERT → HTTP(/cancel 전액) → ASSERT(cancelAmt==amount && remainAmt=='0') |
| pg-03 부분취소 | 3 | keyin(10000) → cancel(3000) → ASSERT(remainAmt=='7000') → /tx 조회 → ASSERT 대사 |
| pg-04 부분취소 소진 | 4 | keyin(5000) → cancel(2000) ASSERT → cancel(3000) ASSERT(remainAmt=='0') → /tx ASSERT(CANCELLED) |
| pg-05 빌키 3단 | 7·8 | /billkey ASSERT(billKey!=null) → /billkey/approve ASSERT → /cancel ASSERT |
| pg-06 가상계좌 | 10 | /va(autoDepositSec=2, notiUrl=wait) → ASSERT(acctNo!=null) → WAIT(입금노티, 60s) → ASSERT(금액 일치) → /va/status ASSERT(deposited) |
| pg-07 승인노티 대사 | 11·14 | keyin(notiUrl=wait) → WAIT(승인노티) → /tx(tid=노티 tid) → ASSERT(금액 일치) |
| pg-08 취소노티 | 12 | keyin → cancel(notiUrl=wait) → WAIT(취소노티) → ASSERT(cancelTid 일치) |
| pg-09 EUC-KR 왕복 | 23 | /legacy/euckr charset=EUC-KR → ASSERT(custName=='홍길동') |
| pg-10 MS949 | 24 | /legacy/949 charset=MS949 → ASSERT(recvContentType matches windows-949) |
| pg-11 규격 3종 체인 | 25·26·27 | /legacy/xml(respType=xml) ASSERT → /legacy/urlenc ASSERT(tid!=null) → /legacy/raw(bodyType=raw, `{{tid}}` 삽입) ASSERT |
| pg-12 해시 서명 | 28 | SET(mid·amount·secret) → concat×2 → sha256 → keyin(sign) → ASSERT 0000 |
| pg-13 Basic 인증 | 29 | base64-encode('demo:demo1234') → /secure(헤더 바인딩) → ASSERT 0000 |
| pg-14 텍스트 추출 | 30 | /legacy/text(respType=text) → regex-extract(APPROVAL_NO) → /legacy/confirm(apprNo) → ASSERT(에코 일치) |

## 8. 검증 계획

- 단위: `MockRuntimeTest`(매칭·{param}·조건 연산자·템플릿 토큰 전종·charset 인코딩) — DB 불필요.
- 라이브 e2e: 관리 CRUD → 게이트웨이(CUSTOM 라우트: 조건 분기·템플릿·지연·콜백 발사·EUC-KR) →
  PG 프리셋 전 엔드포인트 → **pg-01~14 전 시나리오 실행**(브라우저 루프 시뮬레이션) →
  기존 demos-e2e(01~06) 회귀 → 백엔드 단위 3종 → 프론트 tsc/oxlint.
- 적대적 멀티에이전트 리뷰(Workflow) 후 확정 결함 수정.

## 9. 한계 (감수)

- PG 프리셋·`{{seq}}` 상태 인메모리(재시작 소실 — suspensions 와 동일 계보).
- mock 서빙 무인증·CORS 오픈(테스트 도구 전제). slug 는 비밀값 아님.
- 콜백 발사는 SsrfGuard 적용 — 운영 프로파일에선 사설망 발사 차단됨(의도).
- 시나리오 21(망취소: 오류 응답을 성공 조건으로 판정)은 노드별 "non-2xx 허용" 규칙 필요 → 후속.
- D군(위변조·중복승인 차단 등)은 시뮬레이터에 검증 로직은 있으나 데모는 없음(사용자 지시로 음성 제외).
