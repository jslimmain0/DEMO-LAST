# 발표용 결제 애플리케이션

발표 흐름: [4장 개요 + 10장면 시연 시나리오](PRESENTATION.md).

최신 시연 순서: [짧은 AI 프롬프트 + 발표자가 직접 실행하는 흐름](DEMO-PROMPTS.md). API 실패 후 Mock을 만들고, 마지막에는 HTML Mock에서 주문 정보를 입력받아 실제 결제창까지 연결한다.

FlowLink가 테스트할 **결제 API 서버와 별도 결제 프론트 서버**다. Spring Boot 3.3.5 / Kotlin 1.9.25 / Java 21의 두 독립 실행 애플리케이션이며 기존 FlowLink backend/frontend 빌드에 포함하지 않는다. 발표용 가상 연동 규격으로 **현대카드는 HTTP, 신한카드는 TCP**를 사용한다. 실제 카드사 운영 규격을 구현한 것은 아니며, 상대 시스템은 FlowLink Mock으로 준비한다.

```text
demo-payment-app/
  payment-api/  :19080 · 토큰 발급 · 화면 세션 준비 · 결제 인증 · HTTP/TCP 승인
  payment-web/  :19081 · 토큰 복호화 · 결제 화면 · 브라우저 returnUrl 폼 POST

가맹점 역할의 FlowLink → API 서버에서 토큰 발급
  → 가맹점 암호화 플러그인 → 프론트 서버 POST /pay
  → 프론트 서버 복호화 → API 서버 화면 세션 준비
  → 카드 선택 → 프론트 서버 → API 서버 결제 인증
  → 인증 결과 수신 → 브라우저 페이지가 returnUrl로 폼 POST
  → FlowLink가 API 서버 승인 호출
       ├─ 현대카드 선택 → 현대카드 HTTP Mock → 결과 검증
       └─ 신한카드 선택 → 신한카드 TCP Mock → 결과 검증
```

각 애플리케이션은 자신의 JAR·설정·Spring Boot 진입점을 가진다. API 서버에는 결제 HTML·JS·복호화 키가 없다.

## 실행

Java 21을 사용한다. Gradle Wrapper를 동봉했으며 처음 빌드할 때 의존성을 다운로드한다.

첫 번째 터미널 — API 서버:

```powershell
cd demo-payment-app
$env:JAVA_HOME="C:\Users\jslim\.jdks\corretto-21.0.10"
.\gradlew.bat :payment-api:bootRun
```

두 번째 터미널 — 프론트 서버:

```powershell
cd demo-payment-app
$env:JAVA_HOME="C:\Users\jslim\.jdks\corretto-21.0.10"
.\gradlew.bat :payment-web:bootRun
```

- API 상태: `http://127.0.0.1:19080/health`
- 프론트 상태: `http://127.0.0.1:19081/health`
- 프론트 시작 화면: `http://127.0.0.1:19081/`
- 종료: 실행한 터미널에서 `Ctrl+C`
- 검사·JAR 생성: 같은 디렉토리에서 `.\gradlew.bat test bootJar`
- API JAR: `payment-api/build/libs/demo-payment-api.jar`
- 프론트 JAR: `payment-web/build/libs/demo-payment-web.jar`
- Linux/macOS: `bash gradlew :payment-api:bootRun`, 별도 터미널에서 `bash gradlew :payment-web:bootRun`

`payment-api/src/main/resources/application.yml`의 `demo.hyundai-http-base-url`, `demo.shinhan-tcp-host`, `demo.shinhan-tcp-port`를 실제 FlowLink Mock 주소로 바꾸고 API 서버를 재시작한다. 기본 현대카드 HTTP 주소는 `http://127.0.0.1:18080/mock/demo-hyundai`, 신한카드 TCP 포트는 `19090`이다. Windows 앱의 개인 Mock을 쓰면 HTTP 주소를 해당 개인 앱 주소로 바꾼다.

프론트의 설정은 `payment-web/src/main/resources/application.yml`이다. `demo-web.payment-api-base-url`은 API 서버 주소, `demo-web.token-key-base64`는 가맹점 암호화와 동일한 키다. API 서버의 `demo.payment-page-url`은 프론트의 `/pay` 주소이며 토큰 발급 응답에 포함된다. 포트 변경 시 해당 주소들도 함께 바꾼다.

빌드한 JAR의 설정은 명령행이나 환경변수로도 덮어쓸 수 있다.

```powershell
& "$env:JAVA_HOME\bin\java.exe" -jar payment-api\build\libs\demo-payment-api.jar --demo.hyundai-http-base-url=http://127.0.0.1:18080/mock/demo-hyundai --demo.shinhan-tcp-host=127.0.0.1 --demo.shinhan-tcp-port=19090
# 다른 터미널
& "$env:JAVA_HOME\bin\java.exe" -jar payment-web\build\libs\demo-payment-web.jar --demo-web.payment-api-base-url=http://127.0.0.1:19080
```

앱은 PC 루프백에만 바인딩한다. 중앙 공용·팀 워크플로에서 PC의 데모 서버를 호출하려면 해당 HTTP 노드를 **내 PC 실행**으로 설정한다. 플러그인은 공용·팀 중앙 서버에서 실행한다. 중앙 서버가 다른 컴퓨터라면 Mock 주소와 콜백 호스트도 그 컴퓨터 주소로 지정한다.

발표 데이터는 프로세스 메모리에 최대 500건 보관한다. 서버를 재시작하면 주문·토큰·결제 이력이 초기화된다. 샘플 키와 카드번호는 테스트용이다.

## 실제 시연 순서

1. 현대카드 HTTP Mock을 만든다.
2. `cardIssuer: HYUNDAI`로 API 정상·거절 시나리오를 실행한다. 결제 화면에서도 현대카드를 선택해 전체 흐름을 보여 준다. **이때 신한카드 TCP Mock은 없어도 된다.**
3. HTTP 시연 중 또는 이후 신한카드 TCP 전문·Mock을 준비한다.
4. 같은 API 시나리오의 `cardIssuer`를 `SHINHAN`으로 바꾸거나, 같은 결제 화면에서 신한카드를 선택해 TCP 전문·로그를 보여 준다.

### API 시나리오

`토큰 발급 → 결제 준비(카드번호 포함) → 승인 → ASSERT`

승인 API는 **선택한 카드사 한 곳만** 호출한다. `HYUNDAI`는 HTTP 승인, `SHINHAN`은 TCP 승인이다. 현대카드는 TCP를 호출하지 않고, 신한카드는 HTTP를 호출하지 않는다. 선택한 카드사의 Mock이 준비되지 않았으면 연동 오류를 반환한다.

### 결제 화면 시나리오

`토큰 발급(returnUrl 포함) → 가맹점 암호화(변환) → FORM → WAIT → 승인 → ASSERT`

1. 토큰 발급 요청의 `returnUrl`에는 WAIT 노드의 `{{ url@대기노드ID }}`를 연결한다.
2. 발급된 `token`을 가맹점용 플러그인의 입력으로 전달한다. 키도 **입력 포트**로 연결한다.
3. FORM 노드에서 **프론트 서버** `http://127.0.0.1:19081/pay`로 POST한다. 폼 필드 `encryptedToken`에는 플러그인의 암호화 결과를 넣는다.
4. 프론트 서버가 토큰을 복호화하고, **API 서버**에 평문 토큰으로 화면 세션을 준비한 뒤 화면을 연다. 평문 토큰으로는 프론트 화면을 열 수 없다.
5. 화면에서 현대카드(HTTP) 또는 신한카드(TCP)의 정상·거절 시나리오 카드를 선택하고 결제 요청을 보낸다.
6. 브라우저가 프론트 서버에 카드 선택을 보내고, 프론트 서버는 API 서버의 `/api/payments/complete`로 결제 인증을 요청한다. API는 `authenticated: true`, `returnUrl`, `callbackFields`를 반환한다. **API·프론트 서버는 returnUrl로 HTTP 요청을 보내지 않는다.** 페이지의 `pay.js`가 인증 결과를 숨김 폼 필드로 채워 `returnUrl`에 `application/x-www-form-urlencoded` POST submit한다. 팝업은 콜백 응답 페이지로 이동한다. **`code: READY`는 인증 접수 결과이며 최종 승인은 아니다.**
7. WAIT 출력의 `paymentId`로 승인 API를 호출한다. 외부 HTTP·TCP 결과를 ASSERT로 확인한다.

콜백 호스트는 `demo.allowed-callback-hosts`에 정확한 호스트명/IP를 등록한다. 기본은 루프백만 허용한다. 콜백 URL은 **브라우저에서 접근 가능**해야 하며 팝업도 허용한다. 결제 페이지의 CSP는 토큰에 저장된 returnUrl의 origin으로 폼 제출을 허용한다. API 인증 실패는 페이지에서 재시도할 수 있다. 폼 제출 후 콜백 수신 성공 여부는 가맹점/WAIT에서 확인하며, API는 `callbackDelivered` 같은 전달 완료 상태를 기록하지 않는다. 인증된 카드 선택은 고정되고 같은 요청 재시도는 같은 인증 필드를 반환한다. 완료된 승인은 재요청 시 같은 결과를 반환한다. HTTP·TCP 승인 응답을 받지 못하면 결과를 `UNKNOWN`으로 보관하고 자동 재승인하지 않는다.

## API 규격

모든 API POST 본문은 `application/json`이다. `/pay`는 폼의 `application/x-www-form-urlencoded`도 받는다. 오류는 HTTP 4xx/5xx와 `{ "code": "...", "message": "..." }`로 반환한다.

| 서버 | API | 요청 | 성공 응답 |
|---|---|---|---|
| API :19080 | `POST /api/tokens` | `merchantId`, `orderId`, 정수 `amount`, 선택 `returnUrl` | 201: `token`, `expiresAt`, `paymentUrl` |
| API :19080 | `POST /api/payments/prepare` | `token`, 선택 `cardIssuer`+`cardNumber` | 화면 세션: `paymentId`, `pageKey`, `returnUrl`, `hasReturnUrl`, `status`, `amount` 등 |
| 프론트 :19081 | `POST /pay` | `encryptedToken` | 프론트 서버에서 복호화한 뒤 결제 HTML |
| 프론트 :19081 | `POST /api/payments/complete` | 화면의 `paymentId`, `pageKey`, `cardIssuer`, `cardNumber` | API 서버 결제 인증 결과를 페이지로 전달 |
| API :19080 | `POST /api/payments/complete` | `paymentId`, `pageKey`, `cardIssuer`, `cardNumber` | `status: AUTHENTICATED`, `authenticated`, `returnUrl`, `callbackFields` |
| API :19080 | `POST /api/payments/approve` | `paymentId` | `status`, `code`, `stage`, `approvalNo` 등 |
| API :19080 | `GET /api/payments/{paymentId}` | 없음 | 현재 결제 상태 |

토큰 발급 예시:

```json
{
  "merchantId": "DEMO_SHOP",
  "orderId": "ORDER_001",
  "amount": 10000
}
```

API만 테스트할 때 결제 준비 예시:

```json
{
  "token": "토큰 발급 응답값",
  "cardIssuer": "HYUNDAI",
  "cardNumber": "1111222233334444"
}
```

카드번호를 전달할 때 `cardIssuer`도 함께 전달한다. 값은 `HYUNDAI` 또는 `SHINHAN`이다. 정상 승인 시 `status: APPROVED`, `code: 0000`, 현대카드는 `stage: HTTP`, 신한카드는 `stage: TCP`를 검증한다. Mock의 예상 거절이면 HTTP 200과 `status: DECLINED`를 반환한다. 연동 장애는 HTTP 502, 이후 같은 주문 재승인은 HTTP 409다.

## 현대카드 HTTP Mock 규격

HTTP Mock을 직접 만드는 시연에 쓰는 간단한 규격이다. 현대카드를 선택하면 결제 서버가 `demo.hyundai-http-base-url` 뒤에 `/authorize`를 붙여 JSON POST한다. 요청은 결제번호·카드번호·금액 세 필드, 응답은 결과코드·승인번호 두 필드만 사용한다.

**카드사 HTTP/TCP 연동에는 암복호화·서명 필드가 없다.** 암복호화는 앞의 결제창 토큰 전달 단계에서만 시연한다.

```json
{
  "paymentId": "000000000001",
  "cardNumber": "1111222233334444",
  "amount": 10000
}
```

FlowLink HTTP Mock의 경로는 `POST /authorize`다.

- 기본 응답: HTTP 200, JSON `{ "responseCode": "0000", "approvalNo": "HYUN0001" }` → 현대카드 승인 완료.
- 조건 응답: 예를 들어 `body.cardNumber == 9999000011112222`이면 HTTP 200, JSON `{ "responseCode": "1001", "approvalNo": "" }` → 현대카드 승인 거절.
- HTTP 500·지연·잘못된 JSON: 연동 오류 확인용.

## 신한카드 TCP 전문 규격

기준 정의는 `card-protocol.json`이며 FlowLink의 `ProtocolSpec` 형식이다. 전문 작성에 참고하거나 프로토콜 편집기에 사용한다. ASCII, 길이 접두사 4바이트는 자기 자신을 제외한다. 오프셋은 0부터 시작한다.

| 요청 필드 | 오프셋 | 길이 | 값 |
|---|---:|---:|---|
| length | 0 | 4 | `0054` |
| messageType | 4 | 4 | `AUTH` |
| paymentId | 8 | 12 | 숫자, 왼쪽 0 패딩 |
| cardNumber | 20 | 16 | 숫자 |
| amount | 36 | 10 | 숫자, 왼쪽 0 패딩 |
| merchantId | 46 | 12 | ASCII, 오른쪽 공백 패딩 |

| 응답 필드 | 오프셋 | 길이 | 값 |
|---|---:|---:|---|
| length | 0 | 4 | `0028` |
| messageType | 4 | 4 | `RESP` |
| paymentId | 8 | 12 | 요청의 paymentId |
| responseCode | 20 | 4 | `0000`: 정상, `1001`: 승인 거절 |
| approvalNo | 24 | 8 | 정상 예: `DEMO0001`, 거절: 공백 8자리 |

신한카드 TCP Mock은 이 프로토콜을 참조하고 `demo.shinhan-tcp-port` 포트에서 수신하도록 만든다. 응답 필드는 다음처럼 설정한다.

```json
{
  "messageType": "RESP",
  "paymentId": "{{ paymentId@req }}",
  "responseCode": "0000",
  "approvalNo": "DEMO0001"
}
```

거절 규칙은 `cardNumber == 9999000011112222` 조건에 `responseCode: 1001`, `approvalNo: ""`를 설정하고 기본 정상 규칙보다 위에 둔다. 화면 카드 이름만으로 거절되지 않으며 **실제 Mock 응답 규칙이 결과를 결정한다.**

## 가맹점 암호화 플러그인 규격

복호화 구현은 **프론트 애플리케이션**의 `payment-web/src/main/kotlin/com/flowlink/demoweb/TokenCrypto.kt`에 있다. 이를 읽고 호환되는 FlowLink 플러그인을 작성하면 된다.

- 알고리즘: AES-256-GCM
- 키: 프론트 `application.yml`의 `demo-web.token-key-base64`를 **표준 Base64로 디코딩한 32바이트**. 같은 문자열을 중앙 시크릿 `demo_token_key`에 넣는다. API 서버에는 이 키를 설정하지 않는다.
- IV: 암호화마다 새로 생성하는 난수 12바이트
- 인증 태그: 16바이트, AAD 없음
- 평문: 발급받은 토큰의 UTF-8 바이트
- 출력: `base64url(IV).base64url(ciphertext).base64url(tag)`, Base64URL의 `=` 패딩 없음
- 입력 포트: `token`, `keyBase64`; 출력 포트 예: `encryptedToken`
- 변환 노드 위치: **토큰 발급 뒤, FORM 앞**. 토큰 발급 요청을 암호화하는 구조가 아니다.

Java/Kotlin의 `AES/GCM/NoPadding`은 암호화 결과 뒤에 태그 16바이트가 붙으므로, 마지막 16바이트를 분리해 세 번째 구간에 넣는다. 키를 플러그인 설정값에 고정하지 말고 입력 포트로 받아 `{{ demo_token_key@secret }}`를 연결한다.

## 검증 범위

`gradlew test`는 API·프론트 각 Spring Boot 서버를 테스트한다. API 검사는 인증 결과·카드 선택 고정·서버 콜백 미전송·카드사별 HTTP/TCP 분기·거절·연동 실패·동시 승인을 확인한다. **TCP 리스너를 종료한 상태에서 현대카드 승인 성공**, **현대카드 HTTP 장애 중 신한카드 승인 성공**도 확인한다. 프론트 검사는 암호문 변조·평문 거부, 별도 API 전달, returnUrl 폼·HTML 이스케이프·CSP 및 API 장애 처리를 확인한다. 실제 FlowLink 데이터·앱·MCP·IDE 설정은 변경하지 않는다.
