# FlowLink 데모 워크플로 — 전 기능 테스트 세트

FlowLink 의 모든 노드 타입을 실제로 실행해 볼 수 있는 데모 모음.
가짜 대상 시스템(**mock-server.js**)과 데모 워크플로 JSON 6종으로 구성된다.

## 1. 기동 (터미널 4개)

```powershell
# ① 백엔드 (H2 파일 DB — Postgres 불필요)
powershell -ExecutionPolicy Bypass -File backend\scripts\start.ps1 -H2

# ② relay — wait(콜백 대기) 노드의 콜백 수신기 (리포 루트)
node relay.js            # :8787

# ③ mock — 데모가 때릴 가짜 시스템 (리포 루트)
node mock-server.js      # HTTP :9090 + TCP :9091

# ④ 프론트
cd frontend; npm run dev # :5173
```

`http://localhost:9090/` 을 열면 mock 이 제공하는 엔드포인트 목록을 볼 수 있다.

## 2. 데모 불러오기

1. `http://localhost:5173` → 새 플로우 생성(또는 기존 플로우 열기)
2. 에디터 탑바 **[가져오기]** → 파일 선택 → `demos/demo-XX-….json`
3. **[저장]** 후 **[▶ 실행]**

## 3. 데모 목록

| 파일 | 검증하는 기능 | 실행하면 벌어지는 일 |
|---|---|---|
| `demo-01-결제게이트웨이.json` | SET · **FORM(팝업)** · **WAIT(콜백)** · IF · HTTP | 결제창 팝업이 뜬다 → **[결제 승인]** 클릭 → 결과가 wait 수신 URL 로 POST → 팝업에 "결제가 완료되었습니다"(wait 노드에 설정한 콜백 응답) → IF 승인 분기 → `/pay/status` 로 tid 조회. **버튼을 안 누르면 180초 뒤 타임아웃**, [거절] 은 false 분기 |
| `demo-02-OTP인증.json` | HTTP · **INPUT(사용자 입력)** · IF | OTP 발송 API 호출 → 입력 모달이 뜬다(안내 문구에 `{{ hint@… }}` 바인딩) → `111111` 입력 시 인증 성공 분기, 다른 값은 실패 분기, Esc 는 실행 중단 |
| `demo-03-주문API.json` | 로그인 토큰 → **인증 헤더 바인딩** · JSON 필드 타입(number) · **경로 바인딩** · TRANSFORM | 로그인 → `Authorization: Bearer {{ token@… }}` 로 주문 생성(qty 는 숫자로 전송) → `/api/orders/{{ orderId@… }}` 조회 → concat 변환으로 요약 문구 |
| `demo-04-레거시EUC-KR.json` | **charset EUC-KR** · urlencoded/xml 응답 파싱 | EUC-KR 잔액조회(응답 `custName=홍길동` 이 깨지지 않고 복원) → EUC-KR XML 파싱(name/grade/point) → SET 요약 |
| `demo-05-TCP전문.json` | **TCP 고정길이 전문** · IF | 4자리 길이 프리픽스 + `txCode(4)+acctNo(12)` 전문 송신 → 응답을 `resultCode(2)/balance(12)/custName(10)` 로 슬라이싱(custName 은 EUC-KR "홍길동") |
| `demo-06-클라이언트모드.json` | HTTP **reqMode=client** (C→S) | 백엔드가 아니라 **브라우저가 직접** `/api/echo` 를 호출하고 결과를 노드 출력으로 재개 |

### OpenAPI 임포트 데모 (별도 JSON 없음)

1. `http://localhost:9090/openapi.json` 을 열어 내용 전체 복사
2. 에디터 탑바 **[API]** → 붙여넣기 → 임포트
3. 왼쪽 팔레트에 "FlowLink Mock API" 그룹이 생긴다 — 배열 응답(`/api/products`)의
   출력 자동 추출, `allOf`(Order), 요청 바디 필드 타입(qty=integer) 채움을 확인할 수 있다.
   드래그해 캔버스에 놓으면 바로 호출 가능(mock 이 떠 있으므로).

### 추가로 해볼 것

- **타임아웃/중단**: demo-01 에서 결제창 버튼을 누르지 않으면 타임아웃, 실행 로그의 ⏹ 로 즉시 중단(CANCELLED)
- **느린 API**: HTTP 노드 URL 을 `http://localhost:9090/api/slow?ms=5000` 으로 — 지연 응답
- **401 실패 경로**: demo-03 로그인 password 를 `wrong` 으로 바꾸면 401 → 실행 실패
- **서버 노티**: demo-01 form 노드 Hidden 필드에 `notiUrl` 행을 추가하고 두 번째 wait 노드의
  `{{ url@노드ID }}` 를 넣으면, PG 가 승인 시 서버에서 직접 노티도 발사한다

## 4. 트러블슈팅

- **팝업이 안 뜸** — 브라우저 팝업 차단 해제(주소창 오른쪽 아이콘) 후 재실행
- **wait 가 바로 실패** — relay(:8787)가 떠 있는지, 에디터 wait 노드 속성의 relay 주소가 맞는지 확인
- **HTTP 노드가 SSRF 차단** — 백엔드를 H2 프로파일로 띄웠는지 확인(로컬 프로파일만 localhost 허용)
- **포트 충돌** — 이전 프로세스가 9090/9091/8787 을 점유 중이면 종료 후 재기동
- mock 의 주문/결제 기록은 메모리에만 있다(재시작하면 사라짐)
