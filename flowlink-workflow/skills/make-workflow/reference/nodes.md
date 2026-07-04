# FlowLink 노드 타입 레퍼런스

모든 노드는 하나의 평면 JSON 객체다. 공통 필드 + 타입별 필드가 같은 객체에 섞인다.

**공통 필드**: `id`(필수, 고유·`[A-Za-z0-9]`, 8자 권장 — 토큰 참조의 유일 키), `type`(필수), `cat`(색 카테고리, 보통 type과 같음 — **단 http는 `"generic"`**), `name`(표시명, 한국어 가능), `x`/`y`(캔버스 좌표 number, 실행 무관).

토큰 참조의 `@id`는 **노드 이름이 아니라 `node.id`** 다. (자세한 문법은 `graph-and-tokens.md`)

---

## start — 시작
진입점. 설정 필드 없음.
```json
{"id":"start001","name":"시작","type":"start","cat":"start","x":40,"y":160}
```

## end — 끝
종료 표식. 설정 필드 없음.
```json
{"id":"end00001","name":"끝","type":"end","cat":"end","x":900,"y":160}
```

## set — 변수
리터럴/바인딩을 평가해 출력 맵(key→value)을 만든다. 하위 노드는 `{{ key@노드id }}`로 참조.
- **필수**: `vars` (배열). 각 원소 `{ id, key, value?, secret?, bound? }`
  - `key`: 출력 키(빈 key 행 무시), `value`: 리터럴 문자열, `secret`: true면 로그 마스킹, `bound`: Binding이면 value 대신 사용
```json
{"id":"set00001","name":"주문정보","type":"set","cat":"set","vars":[
  {"id":"v1","key":"orderId","value":"ORD-777"},
  {"id":"v2","key":"amount","value":"48000"}
]}
```

## if — 조건 분기
SpEL 조건(읽기전용 샌드박스) 평가 → true/false 한 쪽만 활성. **분기 엣지에 `fromPort:"true"`/`"false"` 필수.**
- **필수**: `condition` — `{{ }}` 토큰 섞인 SpEL. 비교·논리·산술·문자열 `+`만. `.contains()`/`.startsWith()` 차단.
```json
{"id":"if000001","name":"승인 분기","type":"if","cat":"if","condition":"{{ resultCode@wait0001 }} == '0000'"}
```

## assert — 검증
if와 같은 조건이지만 분기 대신 **거짓이면 노드 실패 → 실행 FAILED**. 테스트 판정용. 빈 조건은 실패.
- **필수**: `condition`
```json
{"id":"as000001","name":"승인 검증","type":"assert","cat":"assert","condition":"{{ resultCode@wait0001 }} == '0000'"}
```
두 값 비교도 가능: `"{{ tid@wait0001 }} == {{ tid@httpstat }}"`.

## http — HTTP 요청  (cat은 `"generic"`)
server(백엔드 호출, 기본) 또는 client(브라우저 fetch) 모드. `respType`으로 응답을 키-값 맵 파싱.
- **필수**: `method`(GET/POST/PUT/PATCH/DELETE/HEAD), `baseUrl`, `path`
- **선택**: `reqMode`(server|client), `charset`(UTF-8|EUC-KR|MS949|US-ASCII), `bodyType`(json|urlencoded|form|raw|xml), `respType`(json|xml|urlencoded|form|text|binary), `fields`, `outputs`, `baseUrlBound`
  - `fields = { params:[], headers:[], body:[] }`, 각 `NodeField { id, key, value?, bound?, type? }`
  - body의 `type`(string/number/boolean/json/array)은 json 바디에서 따옴표 여부 제어(예 qty는 `"type":"number"`)
  - `outputs: [{ key, type? }]` — 예상 응답 키 선언(파싱 실패 시 전체 본문이 `body` 키)
```json
{"id":"httpordr","name":"주문 생성","type":"http","cat":"generic","method":"POST",
 "baseUrl":"http://localhost:9090","path":"/api/orders","reqMode":"server","bodyType":"json","respType":"json",
 "fields":{"params":[],"headers":[{"id":"f1","key":"Authorization","value":"Bearer {{ token@httplogn }}"}],
   "body":[{"id":"f2","key":"qty","value":"2","type":"number"}]},
 "outputs":[{"key":"orderId","type":"string"}]}
```
경로에 토큰도 가능: `"path":"/api/orders/{{ orderId@httpordr }}"`.

## form — 폼 전송(결제/인증창)
팝업/iframe에 hidden form 자동 제출 후 **기다리지 않고 즉시 다음 노드로**. 결과는 뒤의 wait 노드가 받음.
- **필수**: `formAction`(제출 URL — 비면 실패)
- **선택**: `formMethod`(POST|GET), `formDisplay`(popup|iframe), `fields.body`(hidden 필드)
  - **표준 패턴**: 게이트웨이가 요구하는 콜백 필드(returnUrl 등)의 값에 `{{ url@wait노드id }}`를 꽂는다.
```json
{"id":"form0001","name":"결제창","type":"form","cat":"form",
 "formAction":"http://localhost:18080/mock/pay-mock/checkout","formMethod":"POST","formDisplay":"iframe",
 "fields":{"params":[],"headers":[],"body":[
   {"id":"b1","key":"orderId","value":"{{ orderId@set00001 }}"},
   {"id":"b2","key":"amount","value":"{{ amount@set00001 }}"},
   {"id":"b3","key":"returnUrl","value":"{{ url@wait0001 }}"}]},
 "outputs":[]}
```

## wait — 콜백/노티 수신 대기
relay 수신 URL로 콜백이 올 때까지 WAITING. 콜백 본문(JSON/urlencoded)이 노드 출력. 타임아웃/중단 시 실패.
- **선택**: `waitTimeoutSec`(기본 120), `callbackRespType`(text|html|json), `callbackRespBody`(콜백에 줄 응답), `outputs`(콜백 파싱 키 선언)
  - 수신 URL은 `{{ url@이_wait_노드id }}` 로 **앞 노드에서도** 참조 가능(실행 시작 시 시드됨)
```json
{"id":"wait0001","name":"콜백 대기","type":"wait","cat":"wait","waitTimeoutSec":180,
 "callbackRespType":"html","callbackRespBody":"OK",
 "outputs":[{"key":"resultCode","type":"string"},{"key":"tid","type":"string"},{"key":"amount","type":"string"}]}
```

## input — 사용자 입력 모달
실행 중 브라우저 모달로 값을 받아 출력. 취소=CANCELLED.
- **필수**: `waitFields` — 배열 `{ id, key(=출력 키), label?, type?(string|number|boolean|json) }`
- **선택**: `waitMsg`(안내 메시지, 토큰 가능)
```json
{"id":"input001","name":"OTP 입력","type":"input","cat":"input",
 "waitMsg":"OTP 6자리를 입력하세요 (힌트: {{ hint@httpsend }})",
 "waitFields":[{"id":"wf1","key":"otp","label":"OTP 6자리","type":"string"}]}
```

## transform — 변환
등록된 변환 SPI를 입력·config로 실행.
- **필수**: `transformId`(예 "concat","split")
- **선택**: `config`(Map<string,string>), `fields.body`(입력 포트별 행), `outputs`
```json
{"id":"trconcat","name":"문자열 결합","type":"transform","cat":"transform","transformId":"concat",
 "fields":{"params":[],"headers":[],"body":[
   {"id":"b1","key":"a","value":"주문 완료: "},
   {"id":"b2","key":"b","value":"{{ productName@httpgeto }}"}]},
 "outputs":[{"key":"result","type":"string"}]}
```

## tcp — 고정길이 금융 전문
요청 필드를 바이트 고정길이로 조립해 길이-프리픽스 전문 송신, 응답을 길이대로 슬라이싱.
- **필수**: `tcpHost`, `tcpPort`, `tcpRequest`, `tcpResponse`
- **선택**: `tcpEncoding`(EUC-KR 기본/MS949/UTF-8/US-ASCII), `tcpTimeoutMs`, `tcpPrefixLength`(기본 4, 0=없음), `tcpPrefixIncludesSelf`, `outputs`
  - `tcpRequest`: `{ id, name, length, value?|bound?, pad(left|right), padChar, encoding? }`
  - `tcpResponse`: `{ id, name(=출력 키), length, encoding? }` (위→아래 순서로 응답 슬라이싱)
```json
{"id":"tcp00001","name":"잔액조회 전문","type":"tcp","cat":"tcp","tcpHost":"127.0.0.1","tcpPort":9091,
 "tcpEncoding":"EUC-KR","tcpPrefixLength":4,"tcpPrefixIncludesSelf":false,
 "tcpRequest":[{"id":"r1","name":"msgType","length":4,"value":"BAL1","pad":"right","padChar":" "}],
 "tcpResponse":[{"id":"p1","name":"custName","length":20}],
 "outputs":[{"key":"custName","type":"string"}]}
```
