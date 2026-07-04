# mock 대상 시스템 + 데모 워크플로 스위트 — 설계 (2026-07-04)

> **status: as-built** — `mock-server.js`·`demos/demo-01~06` 은 현행. 현행 진실원은 [CLAUDE.md](../../../CLAUDE.md).

## 배경 · 결정

- 사용자 요청: "모든 기능을 다 테스트해보고 싶다 — 실제 시스템 데모(mock)를 만들 수 있나".
  FlowLink 자체에는 mock 기능이 없으므로, **워크플로가 때릴 가짜 대상 시스템**과
  **각 기능을 쓰는 완성된 데모 워크플로**를 리포에 추가한다.
- 선택지 확인 질문(단일 서버 / 시나리오별 여러 서버 / relay 통합, 데모 전달 방식, PG 실감도)에
  60초 무응답 → **권장안으로 진행**: 단일 `mock-server.js` + `demos/` JSON + 인터랙티브 결제창.
  (사용자가 돌아와 다른 선택을 원하면 조정)
- 커버 대상: HTTP(server/client·json/xml/urlencoded/text·charset EUC-KR), SET, IF(SpEL),
  FORM(팝업), WAIT(relay 콜백), INPUT(모달), TRANSFORM(내장), TCP(고정길이 전문), OpenAPI import.

## 1. mock-server.js (리포 루트, 의존성 0)

relay.js 와 같은 스타일의 단일 파일. `node mock-server.js [httpPort] [tcpPort]`
(기본 HTTP **:9090**, TCP **:9091**). 모든 HTTP 응답 CORS 오픈(클라이언트 모드용), OPTIONS 204.
상태는 전부 인메모리(주문·결제 트랜잭션), 재시작 시 소멸. 콘솔에 요청 로그.

| 그룹 | 엔드포인트 | 동작 |
|---|---|---|
| 안내 | `GET /` | 전체 엔드포인트 목록 HTML(한국어) |
| 안내 | `GET /health` | `{ok:true}` |
| **가짜 PG** | `POST/GET /pay/checkout` | 폼 필드(productName·amount·orderId·returnUrl·notiUrl?)를 받아 **인터랙티브 결제창 HTML**(상품·금액 표시 + [승인]/[거절] 버튼) 렌더. returnUrl 없으면 오류 페이지 |
| | `POST /pay/approve` | 버튼 제출 수신 → 트랜잭션 기록(tid 발급) → notiUrl 있으면 서버 사이드 POST(파이어&포겟) → **returnUrl 로 자동 제출되는 브리지 폼 HTML** 반환(resultCode=0000/9999·resultMsg·tid·orderId·amount·approvedAt). 실 PG의 merchant-return POST 패턴 |
| | `GET /pay/status?tid=` | 기록된 트랜잭션 JSON 조회(승인 후 확인 API 데모) |
| **REST API** | `POST /api/login` | 아무 자격증명 OK `{token,userId,name}` · password=`wrong` 이면 401 |
| | `POST /api/otp/send` | `{sent:true, hint:"모의 OTP는 111111"}` |
| | `POST /api/otp/verify` | otp==111111 → `{verified:true}` 아니면 `{verified:false}` (IF 분기용, 둘 다 200) |
| | `GET /api/products` | 상품 **배열** 응답(OpenAPI 배열 언랩 데모와 연동) |
| | `POST /api/orders` | `Authorization: Bearer tok-*` 필수(401), `{productId,qty(number),memo}` → 201 `{orderId,status,total}` |
| | `GET /api/orders/{id}` | 주문 조회 |
| | `ANY /api/echo` | `{method,path,query,headers,body}` 에코(클라이언트 모드·바인딩 데모) |
| | `GET /api/slow?ms=` | 지연 응답(기본 3000, 최대 30000) |
| **레거시 EUC-KR** | `POST /legacy/inquiry` | urlencoded(EUC-KR) 수신 → `resultCode=00&custName=홍길동&balance=1234500` 을 **EUC-KR 바이트**로 응답, `Content-Type: …; charset=EUC-KR` |
| | `GET /legacy/user.xml` | `<user><name>홍길동</name><grade>VIP</grade><point>1200</point></user>` EUC-KR XML |
| **OpenAPI** | `GET /openapi.json` | /api 를 기술한 OpenAPI 3 스펙 — `$ref` 스키마·배열 응답·`allOf`·타입 있는 requestBody 포함(붙여넣기 임포트용) |
| **TCP :9091** | 고정길이 전문 | 4바이트 ASCII 길이 프리픽스(자기 미포함) + 본문 `txCode(4)+acctNo(12)`. `BAL1` → `resultCode(2)=00 + balance(12, 좌측 0패딩) + custName(10, EUC-KR "홍길동"+공백)` 응답(동일 프리픽스 규약). 그 외 txCode → `99` |

- **EUC-KR 인코딩**: Node 내장으로는 EUC-KR **인코딩**이 불가(TextEncoder=UTF-8 전용) →
  고정 데모 문자열("홍길동" 등)의 EUC-KR 바이트를 **하드코딩 Buffer 리터럴**로 내장
  (.NET `Encoding.GetEncoding(51949)` 로 생성, 주석에 원문 표기). 요청 **디코딩**은
  `TextDecoder('euc-kr')`(Node full-icu 내장) 사용.
- SSRF: h2(로컬) 프로파일은 `allow-loopback=true` 라 server 모드로 localhost:9090/9091 호출 가능.

## 2. demos/ — 가져오기(import)용 데모 워크플로 JSON

에디터 탑바 [가져오기] → 파일 선택으로 로드하는 `{name, nodes, edges}` 포맷.
노드 id 는 가독성 있는 고정 영숫자 8자(중복 없음). 좌→우 배치 좌표 포함.

| 파일 | 사용 기능 | 흐름 |
|---|---|---|
| `demo-01-결제게이트웨이.json` | SET·FORM·WAIT·IF·HTTP | 주문정보 SET → PG 결제창 팝업(FORM, returnUrl=`{{ url@wait노드 }}`) → 콜백 대기(WAIT, html 응답 "결제 완료 창을 닫아주세요") → IF resultCode==0000 → 승인 조회(HTTP /pay/status) |
| `demo-02-OTP인증.json` | HTTP·INPUT·IF | OTP 발송 → 사용자 입력 모달(otp) → 검증 API(바인딩) → IF verified |
| `demo-03-주문API.json` | HTTP(인증 헤더)·필드 타입·TRANSFORM | 로그인 → 주문 생성(Bearer `{{ token@… }}`, qty=number) → 주문 조회(경로 바인딩) → concat 변환 |
| `demo-04-레거시EUC-KR.json` | charset·urlencoded/xml respType | EUC-KR 잔액조회(urlencoded) → EUC-KR XML 사용자 조회 → SET 요약 |
| `demo-05-TCP전문.json` | TCP·IF | BAL1 잔액조회 전문 → IF resultCode==00 |
| `demo-06-클라이언트모드.json` | HTTP reqMode=client | 브라우저가 직접 /api/echo 호출 → 바인딩 |
| `README.md` | — | 기동 순서(backend H2·relay·mock·frontend), 데모별 절차·기대 결과, OpenAPI 임포트 방법(/openapi.json 복사→[API] 붙여넣기), 트러블슈팅(팝업 차단·포트 충돌) |

- wait 타임아웃 테스트는 demo-01 에서 결제창 버튼을 안 누르면 재현(별도 데모 불필요).
- IF 조건은 SpEL: `{{ resultCode@waitId }} == '0000'`, `{{ verified@vId }} == true`(불리언 객체 바인딩).

## 3. 검증

- `demos-e2e.mjs`(스크래치패드): 라이브 스택(backend H2 + relay + mock)에서 데모 JSON 을
  API 로 플로우 생성·실행하고 브라우저 루프를 시뮬레이션 —
  form pending → PG `/pay/approve` 호출 + 콜백을 wait 수신 URL 로 POST → SSE 수신 → resume,
  input pending → formValues resume, client pending → 직접 fetch 후 resume.
  단언: EUC-KR "홍길동" 복원, TCP 응답 슬라이싱, IF 분기, 401→분기, tid 조회 일치.
- 프론트 무변경(기존 기능만 사용) → tsc/린트 재검증 불필요. 백엔드 무변경.

## 4. 한계 (감수)

- mock 상태 인메모리(재시작 시 주문/tid 소실) — 데모 목적상 충분.
- OpenAPI 임포트는 URL 페치 미지원(기존 다이얼로그가 붙여넣기 전용) → 복사→붙여넣기 안내.
- 결제창 팝업은 브라우저 팝업 허용 필요(기존 form 노드 한계 그대로).
- TCP 데모의 한글 필드는 EUC-KR 고정(하드코딩 바이트) — mock 이므로 임의 문자열 인코딩은 범위 밖.
