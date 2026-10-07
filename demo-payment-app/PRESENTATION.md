# FlowLink 발표 시나리오

4장 개요 + 10개 시연 장면. 대사 없이 화면과 조작 흐름만 정리한다. 약 10~12분이며 15·16번 장면은 사용하지 않는다.

전할 한 줄: **실제 애플리케이션 소스를 AI에게 주고, 연동 규격에서 Mock·워크플로·플러그인을 만들어 통합 테스트까지 실행한다.**

시연의 출발점은 이 디렉토리의 실제 Spring Boot 소스다. 별도 규격서를 먼저 전달하거나 사람이 Mock 필드를 하나씩 입력하는 흐름이 아니라, **소스 전달 → AI 분석·생성 → 사람이 결과 확인 → 실행**을 반복한다.

## AI에게 전달할 소스

아래 경로는 `demo-payment-app/` 기준이다.

| 용도 | 소스 | 읽어 낼 내용 |
|---|---|---|
| API 워크플로 | `payment-api/src/main/kotlin/com/flowlink/demo/PaymentController.kt`, `PaymentService.kt` | 엔드포인트·요청·응답·토큰/결제번호 바인딩·카드사 분기 |
| 현대카드 HTTP Mock | `PaymentService.kt`의 `approve()` 및 API `application.yml` | `/authorize` 요청 필드·응답 검증·Mock 목적지 |
| 신한카드 TCP 전문·Mock | `payment-api/src/main/kotlin/com/flowlink/demo/CardTcp.kt` 및 API `application.yml` | 길이 접두사·문자셋·필드 순서/길이·응답 검사·접속 정보 |
| 토큰 암호화 플러그인 | `payment-web/src/main/kotlin/com/flowlink/demoweb/TokenCrypto.kt` | 복호화와 호환되는 암호화 알고리즘·IV·태그·출력 형식 |
| 화면·콜백 워크플로 | `PaymentWebController.kt`, `TokenCrypto.kt`, `PaymentService.kt`, `payment-web/src/main/resources/static/pay.js` | FORM 입력·프론트/API 분리·READY 콜백·승인 순서 |

`card-protocol.json`과 README는 발표자 검토용이다. TCP 정의를 생성할 때는 `CardTcp.kt`를 먼저 읽게 해서 전문을 소스에서 추출하는 장면을 보여 준다. 키 값 대신 설정 항목과 시크릿 이름만 전달한다.

## 시작 전 준비

- 결제 API 서버 `:19080`과 별도 결제 프론트 서버 `:19081`을 실행한다.
- 현대카드 HTTP 목적지는 `/mock/demo-hyundai`, 신한카드 TCP 목적지는 `:19090`으로 설정한다. 처음에는 두 Mock을 만들지 않는다.
- 소스, FlowLink Mock 서버, 프로토콜 편집기, 워크플로 에디터를 열어 둔다.
- 시연 워크플로와 플러그인은 공용·팀 공간에서 준비한다. PC 데모 서버를 호출하는 노드에는 내 PC 실행을 적용한다. 중앙 서버의 Mock을 사용하면 데모 서버의 목적지를 해당 서버 주소로 지정한다.
- 가맹점용 토큰 키는 시크릿으로 등록할 수 있게 준비하고, 프론트의 복호화 키와 같게 맞춘다. 화면에는 실제 키를 노출하지 않는다.
- 팝업을 허용한다. WAIT 콜백 주소가 브라우저에서 접근 가능하고, 콜백 호스트 허용 목록에 등록되어 있는지 확인한다.
- 새 주문으로 각 시나리오를 실행한다. 승인 완료 주문을 재사용하면 저장된 결과가 반환되어 Mock 변경 효과를 볼 수 없다.

## 개요 4장

| 장면 | 화면 | 흐름 | 시간 |
|---|---|---|---|
| 1 | 상대 시스템이 비어 있는 결제 구조 | 실제 결제 API·프론트는 준비됨 → 현대카드·신한카드는 미준비 → Mock으로 연동 검증 | 20초 |
| 2 | 서버와 카드사 연결 구조 | 가맹점 역할 FlowLink → API 서버 / 별도 프론트 서버 → API 서버 → 선택한 카드사 한 곳 | 30초 |
| 3 | 소스 기반 생성 순서 | 소스 분석 → 현대카드 HTTP Mock·워크플로 → 신한카드 TCP 전문·Mock → 토큰 플러그인·화면 통합 | 20초 |
| 4 | 최종 테스트 흐름 | 토큰 발급 → 가맹점 암호화 → 프론트 복호화·카드 선택 → READY 콜백 → 승인 → ASSERT | 30초 |

2번 구조에서 현대카드는 HTTP, 신한카드는 TCP로 분기한다. 두 카드사를 연속 호출하는 구조가 아니다. 카드사 연동에는 암복호화가 없고, 암복호화는 결제창에 전달하는 토큰에만 적용한다.

## 시연 10장면

### 5. 실제 애플리케이션 소스를 AI에게 전달

소스 디렉토리 열기 → API 컨트롤러·서비스·설정을 AI에게 전달 → API와 외부 연동 분석 요청 → AI가 근거로 읽은 코드 위치와 분석 결과 확인.

AI 작업 요청: 소스에서 토큰 발급·결제 준비·승인 API의 요청/응답을 정리하고, 현대카드 HTTP와 신한카드 TCP 분기 및 외부 목적지 설정을 찾아라. 아직 TCP Mock이나 토큰 플러그인을 만들지 마라.

현대카드 규격: `POST /authorize`, 요청 `paymentId`, `cardNumber`, `amount` / 응답 `responseCode`, `approvalNo`.

신한카드는 TCP 분기와 `CardTcp.call()` 호출까지만 확인한다. 전문 분석·Mock 생성은 HTTP 시연 이후에 진행한다.

### 6. 소스에서 현대카드 HTTP Mock 생성

AI가 `PaymentService.approve()`의 HTTP 분기 읽기 → 요청·응답 규격 추출 → FlowLink HTTP Mock 생성 → 사람이 라우트·기본 응답 확인 → 발급된 URL과 앱 설정 확인.

AI 작업 요청: 현대카드 HTTP 호출 코드에 맞는 `demo-hyundai` Mock을 생성하라. 요청은 소스의 세 필드를 그대로 사용하고, 정상 응답은 아래 값으로 구성하라. TCP와 카드사 암복호화는 추가하지 마라.

```json
{"responseCode":"0000","approvalNo":"HYUN0001"}
```

요청·응답은 평문 JSON이다. 서명·암호화·복호화 노드를 추가하지 않는다.

### 7. 소스에서 현대카드 API 워크플로 생성

AI에게 컨트롤러·서비스를 기준으로 현대카드 정상 테스트 워크플로 생성 요청 → 생성된 노드·요청 필드·출력 바인딩·ASSERT를 에디터에서 확인.

START → 토큰 발급 HTTP → 결제 준비 HTTP → 승인 HTTP → ASSERT → END.

- 토큰 발급: `merchantId=DEMO_SHOP`, 새 `orderId`, `amount=10000`.
- 결제 준비: 앞의 `token` 바인딩, `cardIssuer=HYUNDAI`, `cardNumber=1111222233334444`.
- 승인: 앞의 `paymentId` 바인딩.
- 검증: `status=APPROVED`, `code=0000`, `stage=HTTP`, `approvalNo=HYUN0001`.

토큰·결제번호의 출력 바인딩을 보여 준다. API 시연에는 결제창용 토큰 암호화가 필요 없다.

### 8. 현대카드 HTTP 정상 승인 실행

새 주문으로 실행 → 각 노드 출력 확인 → ASSERT 통과 → 현대카드 Mock의 수신 요청·응답 확인.

수신 요청의 결제번호·카드번호·금액이 워크플로 입력과 같은지 확인한다. **TCP Mock이 없는 상태에서 정상 완료되는 장면**을 보여 준다.

### 9. 현대카드 HTTP 거절 규칙 시연

AI에게 HTTP 거절 규칙과 대응 테스트 추가 요청 → `cardNumber=9999000011112222` 조건 규칙 생성 → 사람이 기본 정상 규칙보다 우선하는지 확인 → 거절 응답 저장.

```json
{"responseCode":"1001","approvalNo":""}
```

AI가 생성한 거절 시나리오의 카드번호·ASSERT 확인 → 새 주문으로 실행 → `status=DECLINED`, `code=1001`, `stage=HTTP` ASSERT 통과 → Mock의 조건 일치·응답 확인.

기대한 거절은 테스트 성공이다. 예상과 다른 값이 나와야 ASSERT가 실패한다.

### 10. TCP 소스에서 전문 정의·Mock 생성

AI에게 `CardTcp.kt`와 접속 설정 전달 → `request()`의 전문 조립과 `call()`의 응답 파싱 분석 → 프로토콜 정의 생성 → 정상·거절 TCP Mock 생성 → 사람이 필드·길이·패딩·응답 규칙 확인 → `19090` 수신.

AI 작업 요청: TCP 클라이언트 소스에서 요청·응답 전문을 추출해 FlowLink 프로토콜과 신한카드 Mock을 생성하라. 길이 접두사가 자기 자신을 제외하는 것과 요청 결제번호를 응답에 돌려주는 것을 반영하라. 암복호화는 넣지 마라.

요청은 길이 접두사 포함 58바이트, 응답은 32바이트다. 전문에는 암복호화 필드가 없다.

기본 응답: `messageType=RESP`, `paymentId={{ paymentId@req }}`, `responseCode=0000`, `approvalNo=DEMO0001`.

거절 조건: `cardNumber=9999000011112222` → `responseCode=1001`, `approvalNo` 공백 8자리. 조건 규칙을 기본 규칙보다 우선한다.

### 11. 신한카드 TCP 정상·거절 실행

AI에게 기존 현대카드 흐름을 바탕으로 신한카드 정상·거절 시나리오 생성 요청 → `cardIssuer=SHINHAN` 및 `stage=TCP`, `approvalNo=DEMO0001` 검증 확인 → 새 주문으로 정상 실행 → TCP 수신 필드·길이·hex·응답 확인.

거절 카드번호와 거절 ASSERT로 새 주문 실행 → `DECLINED`, `1001`, `TCP` 확인.

이때 현대카드 HTTP Mock의 요청 기록이 늘어나지 않는 것을 확인한다. 선택한 카드사만 호출된다.

### 12. 가맹점 토큰 암호화 플러그인 준비

AI에게 프론트의 `TokenCrypto.kt` 전달 → 복호화 구현과 호환되는 가맹점용 암호화 플러그인 생성 요청 → 입력 `token`, `keyBase64` / 출력 `encryptedToken` 확인 → 플러그인 등록 → 사람이 키를 시크릿으로 등록 → 암호화 시험·출력 확인 → 승인본 사용.

출력 형식은 `base64url(IV).base64url(ciphertext).base64url(tag)`다. 토큰 발급 응답의 평문 토큰을 암호화한다. 카드사 요청·응답은 이 플러그인을 거치지 않는다.

### 13. 별도 프론트 결제창 열고 카드 선택

AI에게 프론트 컨트롤러·JS와 API 서비스 전달 → 암호화 토큰 FORM 입력과 READY 콜백 처리 분석 → 화면 통합 워크플로 생성 요청 → 사람이 FORM·WAIT·승인 바인딩 확인:

START → 토큰 발급 → 암호화 TRANSFORM → FORM → WAIT → 승인 HTTP → ASSERT → END.

WAIT의 `{{ url@대기노드ID }}`를 토큰 발급 요청의 `returnUrl`에 연결 → 발급 `token`과 시크릿 키를 TRANSFORM에 연결 → `encryptedToken`을 FORM 필드로 연결 → FORM을 **별도 프론트 서버 `:19081/pay`**에 POST → 팝업 열림.

프론트 서버가 토큰 복호화 → API 서버 `:19080`에 화면 세션 준비 요청 → 실제 카드 선택 화면 표시 → 현대카드 정상 선택 → 결제 인증 요청.

### 14. 콜백 수신·최종 승인·검증

페이지 → 프론트 → API 결제 인증 요청 → 인증 결과 반환 → **브라우저 페이지가 returnUrl의 WAIT 주소로 숨김 폼 POST submit** → WAIT 재개 → `paymentId` 바인딩으로 승인 API 호출 → **선택한 카드사 Mock** 호출 → 최종 ASSERT 통과. API·프론트 서버가 returnUrl을 호출하는 구조가 아니다.

현대카드 선택 시 HTTP 승인과 `HYUN0001` 확인 → 새 주문으로 다시 결제창 열기 → 신한카드 선택 → TCP 승인과 `DEMO0001` 확인.

READY 콜백은 카드 선택·결제 요청 접수다. 최종 승인 결과는 뒤의 승인 API에서 확인한다. 마무리 화면에는 워크플로 결과·선택한 카드사 Mock 기록·승인 결과를 함께 보여 준다.

## 보여 줄 최종 결과

실제 소스 전달 → AI가 HTTP 규격 추출·Mock·워크플로 생성 → HTTP 정상·거절 실행 → TCP 소스에서 전문·Mock 생성 → TCP 실행 → 복호화 소스에서 암호화 플러그인 생성 → 화면·콜백 흐름 생성 → 최종 승인 검증.

AI 작성은 발표의 중심 장면이다. 생성 중에는 소스 근거와 결과 검토를 보여 주고, HTTP 시연을 마친 뒤 TCP 생성을 진행한다. 발표 전 같은 소스로 생성 과정을 리허설하고 결과를 준비한다. 이 문서는 발표 시나리오이며 실제 FlowLink 리소스 생성·실행을 완료했다는 기록은 아니다.
