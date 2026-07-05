# FlowLink 데모 워크플로 — 백엔드 내장 Mock 대상

HTTP/폼/콜백/변환 등 핵심 노드 흐름을 돌려보는 데모 5종. 대상 시스템(가짜 결제 게이트웨이·REST
API·레거시 EUC-KR)은 **FlowLink 백엔드 내장 Mock 기능**(`/mock/{slug}/**`)으로 세운다 —
별도 프로세스(구 `mock-server.js`) 없이 백엔드 안에서 서빙한다.

> **두 가지 데모 갈래**:
> - **이 폴더(01~04·06)** — `demos/seed-mock.mjs` 로 세우는 통합 mock(slug `demo`)을 대상으로 하는 기본 투어.
> - **[`pay-mock/`](pay-mock/README.md)** — Mock 서버 편집기(상단 "Mock 서버" 탭)와 **검증(assert) 노드**로
>   "결제창 뜨고 콜백" 흐름을 만드는 다음 단계 데모. UI 에서 직접 mock 을 세우는 법을 다룬다.

## 1. 기동 (터미널 2개 + 브라우저)

```powershell
# ① 백엔드 (H2 파일 DB — Postgres 불필요, wait 콜백 수신 내장)
powershell -ExecutionPolicy Bypass -File backend\scripts\start.ps1 -H2

# ② 프론트
cd frontend; npm run dev          # :5173
```

그런 다음 **mock 대상 시스템을 백엔드에 심는다**(한 번만 — 재실행하면 최신 라우트로 upsert):

```
node demos/seed-mock.mjs          # 백엔드(:18080)에 slug `demo` mock 생성/갱신
```

- 서빙 base URL: `http://localhost:18080/mock/demo` (데모 JSON 의 baseUrl / formAction 이 이 주소를 가리킨다)
- 라우트 확인: `http://localhost:18080/mock/demo/__routes`
- 콜백 대기(01)의 wait 콜백은 **백엔드가 직접 받는다**(별도 relay 프로세스 불필요) — 백엔드+프론트 2개면 모든 데모가 돈다.

## 2. 데모 불러오기

1. `http://localhost:5173` → 새 플로우 생성(또는 기존 플로우 열기)
2. 에디터 탑바 **[가져오기]** → 파일 선택 → `demos/demo-XX-….json`
3. **[저장]** 후 **[▶ 실행]**

## 3. 데모 목록

| 파일 | 검증하는 기능 | 실행하면 벌어지는 일 |
|---|---|---|
| `demo-01-결제게이트웨이.json` | SET · **FORM(팝업)** · **WAIT(콜백)** · IF · HTTP | 결제창 팝업이 뜬다 → **[결제 승인]** 클릭 → 결과가 wait 수신 URL 로 POST → 팝업에 "결제가 완료되었습니다" → IF 승인 분기 → `/pay/status` 로 tid 조회. **버튼을 안 누르면 180초 뒤 타임아웃**, [거절] 은 false 분기 |
| `demo-02-OTP인증.json` | HTTP · **INPUT(사용자 입력)** · IF | OTP 발송 API 호출 → 입력 모달이 뜬다(안내 문구에 `{{ hint@… }}` 바인딩) → `111111` 입력 시 인증 성공 분기, 다른 값은 실패 분기, Esc 는 실행 중단 |
| `demo-03-주문API.json` | 로그인 토큰 → **인증 헤더 바인딩** · JSON 필드 타입(number) · **경로 바인딩** · TRANSFORM | 로그인 → `Authorization: Bearer {{ token@… }}` 로 주문 생성(qty 는 숫자로 전송) → `/api/orders/{{ orderId@… }}` 조회 → concat 변환으로 요약 문구 |
| `demo-04-레거시EUC-KR.json` | **charset EUC-KR** · urlencoded/xml 응답 파싱 | EUC-KR 잔액조회(응답 `custName=홍길동` 이 깨지지 않고 복원) → EUC-KR XML 파싱(name/grade/point) → SET 요약 |
| `demo-06-클라이언트모드.json` | HTTP **reqMode=client** (C→S) | 백엔드가 아니라 **브라우저가 직접** `/api/echo` 를 호출하고 결과를 노드 출력으로 재개 |

> **demo-05(TCP 고정길이 전문)은 제외** — TCP 노드는 백엔드에서 제거됐고(HTTP 중심으로 정리),
> 구 `mock-server.js` 의 TCP :9091 대상도 폐기와 함께 사라졌다.

### mock 이 무상태로 근사하는 부분

구 `mock-server.js` 는 주문/결제 기록을 메모리에 들고 있었지만, 내장 Mock 은 무상태 템플릿이다. 그래서:

- **주문**: `total`·`productName`·`qty` 는 데모 고정값(p-200 · 2개 · 96,000원)으로 하드코딩. `orderId`/`tid` 는 `{{seq}}`(증가 카운터)로 근사. `GET /api/orders/{id}` 는 경로의 id 만 echo.
- **결제창**: 2단계(결제창→승인처리→returnUrl)를 1단계로 접었다 — 결제창 HTML 의 [승인] 버튼이 곧바로 returnUrl 로 결과(`resultCode=0000`·`tid`)를 POST(pay-mock 데모와 동일 패턴).
- **`/openapi.json`**: 내장 Mock 은 OpenAPI 스펙을 서빙하지 않는다. [API] 임포트를 데모하려면 임의의 OpenAPI 3 문서를 붙여넣어 사용한다.

### 추가로 해볼 것

- **타임아웃/중단**: demo-01 에서 결제창 버튼을 누르지 않으면 타임아웃, 실행 로그의 ⏹ 로 즉시 중단(CANCELLED)
- **지연 응답**: Mock 서버 편집기에서 규칙에 `지연(delayMs)` 을 주거나, 라우트를 추가해 느린 API 를 흉내
- **401 실패 경로**: demo-03 로그인 password 를 `wrong` 으로 바꾸면 401 → 실행 실패

## 4. 트러블슈팅

- **팝업이 안 뜸** — 브라우저 팝업 차단 해제(주소창 오른쪽 아이콘) 후 재실행
- **mock 이 404** — `node demos/seed-mock.mjs` 를 먼저 돌렸는지, `http://localhost:18080/mock/demo/__routes` 가 라우트를 보이는지 확인
- **wait 가 바로 실패** — 백엔드가 떠 있는지 확인(wait 콜백은 백엔드가 `/relay/{execId}/cb/{nodeId}` 로 직접 받는다). 콜백이 안 오면 mock 라우트의 콜백 발사 설정·returnUrl 바인딩(`{{ url@wait노드 }}`)을 점검
- **HTTP 노드가 SSRF 차단** — 백엔드를 H2 프로파일로 띄웠는지 확인(로컬 프로파일만 localhost 허용 — 내장 Mock 은 백엔드와 같은 localhost:18080 이라 이 옵션이 필요)
- mock 은 무상태다(주문/tid 는 매 호출 새로 생성). 재시작해도 라우트 정의는 H2 에 남지만, seed 를 다시 돌려 최신화할 수 있다
