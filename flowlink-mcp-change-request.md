# Flowlink 통신사 Mock 지원을 위한 MCP 변경 요청서

작성일: 2026-10-14

상태: 개발 요청 초안. **신규 도구·속성·오류 코드는 제안이며 현행 MCP 계약이 아니다.**

대상 독자: Flowlink MCP·서버 API·Windows 에이전트 개발자.

## 목적과 계약 원칙

화면에서 지원하는 통신사 Mock 기능을 MCP로도 조회·미리보기·저장·시험할 수 있게 한다. 기존 엔진 기능의 단순 노출과 실제 런타임 기능 추가를 구분한다.

이 저장소에는 Flowlink MCP 구현 소스가 없다. 아래는 **변경해야 할 외부 인터페이스와 서버/에이전트 계약**이며, 실제 파일명·내부 REST 경로는 구현 저장소에서 확인한다.

원칙:

- ProtocolSpec v2에만 관련 문서의 `transactions`·`ackMessages`·분리된 ACK send/receive 모델을 저장한다. MockSpec은 기존 tcp.protocolId로 해당 정의를 참조하며 이 속성들을 중복 저장하지 않는다.
- MCP, 화면, 서버, PC에서 별도 스키마·별도 프레이머를 만들지 않는다.
- 저장·검증·미리보기·실제 전송은 서로 구분한다.
- `target/workspace`는 저장 위치다. 환경 출처 `envSource`와 요청 출발지 `executionAgent`를 혼동하지 않는다.
- 시크릿·프로토콜·플러그인은 서버 public 공통 카탈로그를 유지한다.
- 기능 지원 여부를 조회한 후 v2 정의를 사용한다. 미지원 필드를 조용히 버리지 않는다.
- 정의 변경만으로 리스너를 시작하거나 실제 요청을 전송하지 않는다. 활성화는 기존 enabled 계약을 명시적으로 따른다.
- schemaVersion 없는 기존 정의·도구 호출·출력 필드는 유지한다.

## 기존 도구 변경

| 도구 | 요청 변경 | 주의점 |
|---|---|---|
| `flowlink_status` | 서버/PC별 버전·schemaVersion·기능·한도 조회 | PC 미연결/미확인은 지원으로 추정하지 않음 |
| `flowlink_update_status` | PC가 보고한 실제 설치 버전과 배포 버전 분리 | MCP에서 업데이트 설치를 자동 시작하지 않음 |
| `flowlink_guide` | protocol/mock/nodes/rules의 v2·TCP 계약 동기화 | mock 가이드의 HTTP 전용 제한 해소 |
| `protocol_get/list/upsert/version` | v2 필드 보존, 거래·ACK 요약, 컴파일 오류 | 구형 PC 실행 가능 여부와 정의 저장 가능 여부 분리 |
| `protocol_preview` | 업무·ACK 조립 및 수신 바이트 파싱 지원 | 저장·전송 없음 |
| `mock_get/list/upsert/version` | v2 계획·의존성·리스너 정보 제공 | 실패 시 기존 리스너·정의 보존 |
| `mock_send` | 거래 키 선택, 동적 ACK 포함한 실제 시험·단계 결과 | 실제 전송 도구임을 명시 |
| `mock_log` | 업무 전문과 ACK 단계·오류 구분 | 기본 마스킹과 기존 로그 필드 유지 |
| `mock_tcp_sessions` | 현재 거래·단계·누적/기대 바이트 조회 | extend는 기존 유휴 기한 연장뿐 |
| `node_run/flow_run/suite_run` | 같은 v2 실행 계획 사용 | UNKNOWN 자동 재호출 금지 |
| `execution_get/list` | 고정된 정의 버전과 전송 단계 결과 | 업무 성공·전송 완료·앱 성공을 구분 |

### 1. 기능 조회

`flowlink_status`의 기존 출력을 유지하고 `capabilities`를 추가한다.

- `server`와 `local` 각각 버전, 지원 schemaVersion, 기능 상태, 한도, 확인 시각을 반환한다.
- 기능 상태는 `supported` / `unsupported` / `unknown`이다.
- 서버에 기능이 있어도 실제 PC에서 사용 가능한지 별도로 판단한다.
- 최소 기능 키: `transactionFraming`, `transactionAck`, `ackLengthOnly`, `ackMessageTemplates`, `ackFieldValidation`, `binaryIntegers`, `mockPreview`.
- 이미 구현된 lengthAdjustment, fixed/delimiter framing, responseFraming, connection reuse, 승인 코덱 지원도 같은 방식으로 표시한다.
- `maxWireBytes`, `maxAckBytes`, 허용 유휴 제한 등 실제 런타임 한도를 반환한다.
- PC의 `unknown` 기능을 필요로 하는 실행은 전송 전에 오류다.

### 2. 가이드와 도구 스키마

`flowlink_guide(mock)`에 HTTP와 TCP를 모두 설명한다.

현재 존재하는 TCP 구조를 정식 문서화한다:

```text
MockSpec.tcp.port
MockSpec.tcp.protocolId
MockSpec.tcp.rules[].id
MockSpec.tcp.rules[].when
MockSpec.tcp.rules[].then.mode
MockSpec.tcp.rules[].then.fields
```

추가로 다음을 명시한다:

- 정확한 필수·선택 필드, 타입, 기본값, 허용 enum, 조건 op 목록.
- TCP 템플릿 `{{req.필드}}`와 날짜·시각 바인딩의 허용 범위.
- ProtocolSpec의 거래별 프레이밍과 ACK가 Mock에 적용되는 순서.
- ACK를 업무 규칙으로 우회 구현하지 않는 방법.
- 성공 fixture와 strict ACK 검증의 차이.
- 완전한 최소 저장 예시와 부분 스키마 예시의 구분.
- unsupported 필드·시크릿·없는 환경·승인 대기 오류 예시.
- 저장 위치·환경 출처·실행 위치·resourceWorkspaceId 설명.

실제 도구 JSON Schema와 가이드 예시를 동일한 모델에서 생성하거나 같은 계약 검사를 적용한다. `spec: object|string`을 유지하더라도 객체 입력의 v2 구조를 `$defs` 등으로 명확히 안내한다.

### 3. protocol_upsert

기존 `name/spec` 입력을 유지하며 아래를 추가한다:

- `dryRun: boolean` — 기본 false. true면 공통 컴파일만 하고 생성·버전 저장하지 않는다.
- 응답에 `schemaVersion`, `requiredCapabilities`, `compiledSummary`, `warnings`를 추가한다.
- 오류에 `code`, `path`, `message`, `repairHint`를 반환한다.
- 정의 저장은 연결된 PC를 요구하지 않는다. 로컬 실행 가능 여부는 별도 조회·검사한다.

`compiledSummary` 최소 내용:

- 공통 헤더 크기·거래 식별 필드.
- 거래별 요청/응답 키·프레임 길이·ACK 단계.
- ACK 레이아웃 길이·송신 방식·수신 검증 방식.
- 필요한 승인 플러그인·시크릿 이름·바인딩 필드.

이름으로 기존 정의를 갱신하는 현재 계약은 유지한다. dryRun 실패를 새 정의 생성 성공으로 반환하지 않는다.

### 4. protocol_preview

기존 key/values/spec/protocolId/name, frameDirection/direction 계약을 유지한다.

추가 입력:

| 속성 | 제안 값 | 설명 |
|---|---|---|
| `action` | `assemble` / `parse` | 기본 assemble. parse는 바이트를 해석·검증 |
| `transactionKey` | 거래 키 | v2 거래 선택 |
| `phase` | `request` / `requestAck` / `response` / `responseAck` | 기본은 기존 frameDirection에 대응하는 업무 단계 |
| `requestFields` | 필드 객체 | ACK/응답의 원래 요청 컨텍스트 |
| `responseFields` | 필드 객체 | ACK의 응답 컨텍스트 |
| `bytesB64` | Base64 문자열 | parse에서만 필수. 실제 전송 없음 |

계약:

- v1 호출처럼 transactionKey가 없으면 업무 key가 필수다. v2 transactionKey가 있으면 key를 생략할 수 있고 phase에서 업무/ACK 전문 키를 결정한다. ACK phase에는 transactionKey가 필수다. 이는 기존 호출을 유지하면서 key 필수 조건을 완화하는 JSON Schema 변경이다.
- phase 생략은 기존 frameDirection/direction 선택 동작을 유지해 request 또는 response만 결정한다. ACK phase는 명시 입력해야 한다.
- 명시한 업무 phase=request는 frameDirection=send, phase=response는 frameDirection=recv와만 호환된다. frameDirection 생략 시 phase로 경계를 정한다.
- ACK phase에는 frameDirection을 함께 입력할 수 없다. ACK 경계는 ACK receive 계약 또는 send 레이아웃에서 결정한다.
- direction은 기존 코덱 컨텍스트 의미이며 client/mock 역할을 나타내지 않는다. assemble의 기본 send는 유지하고, 새 parse action에서는 기본 recv를 사용한다.
- 업무 조립은 기존 values를 사용하고 ACK 조립은 해당 거래의 send 정의를 사용한다.
- parse는 선택한 phase의 프레이밍과 ACK receive 계약을 검증한다.
- key와 transactionKey가 다른 전문을 가리키면 오류다.
- protocolId/name/spec 선택 충돌, assemble에 bytesB64 입력, 필수 컨텍스트 누락을 오류로 반환한다.
- bytes 입력의 크기·Base64 형식·완전한 프레임 여부를 검증한다.
- TCP 수신 중 누적 상태는 실제 런타임 책임이고, parse 미리보기의 불완전 bytes는 검증 실패다.

출력은 phase, fields, fieldOffsets, declaredLength, wireLength, lengthAdjustment, masked text/HEX/Base64, validations를 제공한다. 기존 필드가 있으면 재사용한다.

입력 phase의 `request/requestAck/response/responseAck`는 로그·실행 단계의 `REQUEST/REQUEST_ACK/RESPONSE/RESPONSE_ACK`와 각각 대응한다. COMPLETE는 최종 전송 상태이며 preview 입력 phase가 아니다.

### 5. mock_upsert와 조회

기존 slug/name/type/spec/enabled/target/workspace를 유지한다.

- `dryRun: boolean`을 추가한다. true면 enabled=true여도 저장·리스너 활성화하지 않는다.
- 전체 MockSpec 교체 계약을 유지하고 서버 소유 metadata는 입력에서 거절하거나 기존 정식 계약으로 처리한다.
- protocolId, 거래별 응답 필드, 코덱, 환경, 승인본 의존성을 공통 컴파일러로 확인한다.
- 응답의 validation 결과에 문제가 있으면 실제 활성화를 하지 않는다.
- 활성화 실패를 LISTENING으로 표시하지 않는다. 정의 저장과 리스너 시작 결과를 구분한다.
- 포트 교체처럼 사전 검증 이후 실패할 수 있는 동작의 원자성 범위를 명시한다.
- 기존 정의·리스너 보존 여부, 실제 현재 버전·활성 상태를 오류 응답에도 제공한다.
- get/version은 v2 속성을 손실 없이 반환한다.
- list에는 거래 수, requiredCapabilities, validation 상태를 추가하되 상세 spec은 get으로 조회한다.
- get/upsert 결과에 canonical HTTP base URL 또는 TCP host/port와 리스너 위치를 반환한다.

### 6. mock_send와 실행 결과

기존 key/values 호출을 유지한다. v2는 `transactionKey`를 추가하고 key와의 일치 여부를 검사한다. transactionKey가 있으면 key는 생략 가능하며 거래의 requestMessage를 사용하고, 둘 다 없으면 오류다. 도구 JSON Schema의 key 필수 조건도 함께 변경한다.

- 저장된 정의·승인 코덱 snapshot으로 실제 연결한다.
- client 역할의 ACK 송수신 정의를 실행한다. length-only receive가 있어도 send ACK는 해당 정의로 조립한다.
- 결과에 선택 거래, request/response/ACK 단계, bytes 수, duration, error를 추가한다.
- 새 v2 시험은 기존 실행 저장소에 기록하고 `executionId`를 반환한다. UNKNOWN이면 execution_get으로 조회한다.
- 테스트 전송은 1회만 한다. timeout 뒤 자동 재전송하지 않는다.
- 호출마다 연결 종료하는 기존 계약을 유지한다. 연결 재사용은 같은 흐름의 TCP 노드들로 시험한다.
- 앱이 보내는 바이트와 같은지 확인해야 하는 경우 합성 데이터의 앱/connector 통합 시험을 별도로 수행한다. mock_send끼리 통신 성공했다고 앱 호환을 보장하지 않는다.

`execution_get`의 단계 결과는 오류가 나도 이미 수신·송신된 부분을 보존한다. Mock이 성공 코드를 보냈더라도 마지막 ACK가 없으면 전송 결과를 COMPLETE로 표시하지 않는다.

### 7. 로그와 세션

기존 mock_log의 업무 로그와 hex 옵션을 유지하면서 다음을 추가한다:

- `transactionKey`, `phase`, `direction`, `expectedBytes`, `actualBytes`, `validationMode`, `errorCode`.
- ACK 값을 업무 출력 필드와 섞지 않는다.
- full/hex 옵션도 시크릿 마스킹을 해제하지 않는다.

mock_tcp_sessions에는 현재 phase와 거래 키, 수신 누적 bytes 수를 추가한다. 기존 starting/waiting/processing 상태·extend 제한은 유지한다. extend를 heartbeat 송신으로 표시하지 않는다.

## 신규 도구 제안

**신규 도구는 `flowlink-mock_preview` 하나만 제안한다.** 나머지는 기존 도구 확장으로 처리한다.

목적: 저장된 Mock 또는 편집 중 MockSpec에 합성 요청을 적용하여 규칙·응답·ACK 실행 계획을 전송 없이 확인한다.

| 입력 | 의미 |
|---|---|
| `target`, `workspace`, `slug` | 기존 저장 위치 계약. 저장 Mock을 조회할 때 slug 필요 |
| `spec` | 선택. 편집 중 전체 MockSpec; 제공하면 저장 spec 대신 미리보기 |
| `type` | HTTP/TCP. 저장 Mock이면 기존 kind와 일치해야 함 |
| `protocolSpec` | 선택. TCP의 편집 중 전체 ProtocolSpec; 저장 공통 정의를 대체하는 미리보기만 허용 |
| `environment` | 선택. 선택 envSource의 환경 이름. 없으면 Mock 환경 사용 |
| `request` | HTTP 또는 TCP 합성 요청 객체 |

요청 입력:

- HTTP: `{method, path, headers, query, body}`. URL을 입력받아 외부 호출하지 않는다.
- TCP: `{key, values}` 또는 `{bytesB64}` 중 하나. 필드 조립과 raw wire 파싱을 구분한다.
- TCP 필드 요청 key에서 거래를 찾거나, bytes 요청 헤더를 파싱해 거래를 선택한다. 모호하면 오류다.
- protocolSpec이 있으면 이 미리보기에서만 사용하며 저장 protocolId를 갱신하지 않는다.
- 슬러그 없는 미저장 spec의 위치·환경은 target/workspace에서 해석한다.

출력:

- 정의 snapshot 또는 `unsaved=true`.
- 선택 거래·HTTP route·규칙, 규칙 매칭 조건.
- 안전한 정규화 요청·응답 필드와 byte 길이.
- ACK 포함 송수신 계획.
- 필요한 기능·코덱 승인·시크릿 이름·필수 바인딩.
- warnings와 validations. 미매칭 규칙을 정상 성공으로 반환하지 않는다.

부작용 없음:

- 저장, 버전 생성, 리스너 시작, 실제 TCP/HTTP 전송, callback 발사 없음.
- 상태 변수·히트 카운터·seq를 변경하지 않는다. state/seq 의존 규칙은 읽은 snapshot과 사용한 가상 값을 결과에 표시한다.
- 기존 승인 코덱만 샌드박스에서 실행한다. 초안을 승인본 대신 사용하지 않는다.
- 임의 URL·파일·프로세스·네트워크에 접근하지 않는다.

## 입력과 출력 예시

**모든 예시는 개발 제안이다. 실재하는 id·추가된 도구·지원 상태라고 해석하지 않는다.**

### 지원 기능 출력 예시

실제 구현 전에는 아래의 supported를 반환해서는 안 된다.

```json
{
  "capabilities": {
    "server": {
      "schemaVersions": [1, 2],
      "features": {
        "transactionFraming": "supported",
        "transactionAck": "supported",
        "ackLengthOnly": "supported",
        "ackMessageTemplates": "supported",
        "ackFieldValidation": "supported",
        "binaryIntegers": "supported",
        "mockPreview": "supported"
      },
      "limits": {"maxWireBytes": 1048576, "maxAckBytes": 1024}
    },
    "local": {
      "available": false,
      "installedVersion": null,
      "schemaVersions": [],
      "features": {"ackLengthOnly": "unknown"}
    }
  }
}
```

### ACK 파싱 미리보기 호출 예시

도구: 확장된 `flowlink-protocol_preview`

```json
{
  "name": "<등록된 SKT 프로토콜 이름>",
  "action": "parse",
  "transactionKey": "<등록된 SKT 거래 키>",
  "phase": "responseAck",
  "requestFields": {
    "sourceId": "MOCK1",
    "destId": "MOCK2",
    "msgId": 130,
    "m3sTid": "000000000000000000001"
  },
  "bytesB64": "<합성 47B ACK의 Base64>"
}
```

꺾쇠 값은 설명용 자리표시자다. 실제 호출은 조회한 이름·거래 키와 유효한 Base64로 대체해야 한다. ACK 생성 정의와 receive 검증 계약은 protocol에 저장된 값을 사용한다.

### Mock 미리보기 호출 예시

도구: 신규 제안 `flowlink-mock_preview`

```json
{
  "target": "local",
  "slug": "<등록된 LGU Mock slug>",
  "type": "TCP",
  "request": {
    "key": "F1:request",
    "values": {
      "protocolCode": "F1",
      "m3sTid": "000000001",
      "phone": "01000000000",
      "amount": "0000100"
    }
  }
}
```

위 값은 합성 데이터다. 다른 필수 요청 필드는 실제 정의의 기본값 또는 명시 입력으로 충족해야 하며 임의 기본값을 엔진이 생성하지 않는다.

### 실행 단계 출력 예시

```json
{
  "transactionKey": "lgu-auth",
  "transportStatus": "SUCCEEDED",
  "steps": [
    {"phase": "REQUEST", "direction": "SEND", "actualBytes": 137, "status": "SUCCEEDED"},
    {"phase": "REQUEST_ACK", "status": "SKIPPED"},
    {"phase": "RESPONSE", "direction": "RECEIVE", "actualBytes": 270, "status": "SUCCEEDED"},
    {"phase": "RESPONSE_ACK", "status": "SKIPPED"}
  ],
  "responseFields": {"result": "00"}
}
```

위 SEND/RECEIVE는 client 역할 기준이다. Mock 로그에서는 반대 방향이다. 실제 출력에는 role과 고정된 정의 버전도 포함한다.

## 오류와 실행 안전성

기존 도구의 오류 envelope를 유지하고 원인 코드를 추가한다. 아래 명칭은 제안이다.

| 코드 | 예 |
|---|---|
| `UNSUPPORTED_CAPABILITY` | 구형 PC가 transactionFraming 미지원 |
| `CAPABILITY_UNKNOWN` | PC 지원 여부를 확인하지 못함 |
| `INVALID_SCHEMA` | ACK send/receive 누락, enum 오류 |
| `AMBIGUOUS_TRANSACTION` | 헤더 조건이 여러 거래에 일치 |
| `UNKNOWN_TRANSACTION` | 거래 미매칭 |
| `FRAME_LENGTH_MISMATCH` | 조립 길이와 고정 길이 불일치 |
| `MISSING_CONTEXT_FIELD` | ACK 템플릿이 참조하는 req 필드 없음 |
| `ACK_TIMEOUT` | ACK 미수신 |
| `ACK_EOF` | 필요한 bytes 이전 연결 종료 |
| `ACK_MISMATCH` | exact/fields 검증 실패 |
| `PLUGIN_NOT_APPROVED` | 승인본 없는 코덱 |
| `ENVIRONMENT_NOT_FOUND` | 선택한 출처에 환경 없음 |
| `SECRET_NOT_FOUND` | 필요한 이름의 시크릿 없음 |
| `LOCAL_AGENT_OFFLINE` | 로컬 실행 불가 |
| `PORT_IN_USE` | 리스너 포트 충돌 |

오류에는 code/path/phase/expectedBytes/actualBytes/repairHint처럼 해당되는 정보만 제공한다. 시크릿·개인정보 원문, 내부 관리 토큰을 오류에 넣지 않는다.

실행 안전성:

- 미리보기는 네트워크를 호출하지 않는다. 실제 전송은 mock_send/http_request/flow_run 등 명시적 실행 도구만 한다.
- 지원 기능·정의 버전·승인 코덱 버전을 계획 단계에서 고정하고 에이전트에서 재검증한다.
- UNKNOWN·접수 불명확 결과에서 새 요청을 만들지 않고 기존 executionId를 조회한다.
- 실행 응답 지연 시에도 조회 가능한 이력을 남긴다.
- 종료 전에 완료해야 할 ACK와 전송 결과를 별도 기록한다.
- 승인은 기존 사용자/관리자 화면 절차를 유지한다. MCP로 자동 승인하지 않는다.
- 이름만 조회하는 secret_list 계약을 유지한다. 새 미리보기 도구도 시크릿 값을 반환하지 않는다.

## 구현 순서와 인수 기준

### 변경 순서

1. 기능 요청서의 공통 모델·컴파일러·ACK 수신·거래별 프레이밍을 서버/PC에 구현하거나 기존 지원을 확인한다.
2. capabilities를 먼저 제공하고 버전 불일치의 전송 전 오류 처리를 구현한다.
3. 기존 protocol/mock 도구에 v2 보존·dryRun·오류 정보를 추가한다.
4. protocol_preview 확장과 mock_preview를 공통 엔진에 연결한다.
5. mock_send·워크플로 실행·로그·세션 조회를 같은 단계 출력으로 연결한다.
6. 모든 관련 가이드와 실제 도구 JSON Schema를 함께 배포한다.

### 인수 기준

| ID | 검증 | 기대 결과 |
|---|---|---|
| M01 | v1 정의 get→upsert→get | 기존 속성·wire 동작 손실 없음 |
| M02 | v2 정의 get/version/export/import | transactions/ackMessages 보존. 실제 자원 id 재매핑은 기존 이관 계약 준수 |
| M03 | dryRun과 mock_preview 실행 | 정의 버전·리스너·state/seq/카운터·외부 요청 수 변화 없음 |
| M04 | protocol_preview assemble→parse | 합성 byte 기대값·길이·필드 일치 |
| M05 | 미리보기와 실제 mock_send 비교 | 같은 거래·응답·ACK 계획 |
| M06 | 서버 신버전/PC 구버전·PC 미연결 | unsupported/unknown/offline 구분, 실제 전송 없음 |
| M07 | ACK/프레임 오류 | 정확한 단계·기대/실제 bytes·repairHint 반환 |
| M08 | secret 사용 시 full/hex/parse 출력 | 모든 표현에서 원문 비노출 |
| M09 | UNKNOWN 시험 결과 조회 | execution_get으로 조회 가능, 자동 새 실행 없음 |
| M10 | HTTP/TCP 가이드 예시 | 실제 JSON Schema와 공통 컴파일러 통과 |
| M11 | mock_upsert 활성화 실패 | 기존 리스너 보존 여부·실제 버전 명확, 성공 위장 없음 |
| M12 | workspace_export/import·복원 | v2 필드 보존, private 자원·시크릿 자동 복사 없음 |

workspace_export/import와 protocol/mock 버전 복원 경로도 확장 필드를 보존하도록 수정한다. import 시 TCP Mock을 꺼두는 기존 계약은 유지한다.

M01~M12는 개발 완료 판정 기준이지 이 문서 작성 과정에서 실행한 시험 결과가 아니다.

## 개발 요청 요약

Flowlink의 기존 TCP 프레이밍·코덱·Mock 규칙을 재사용하여 다음을 구현해 주세요.

1. 같은 리스너에서 거래별 프레임 길이와 ACK 단계를 선택합니다.
2. ACK는 고정 HEX 검증, 내용 검증 없는 고정 길이 수신, 선택적 구조화 생성·필드 검증을 지원합니다.
3. binary 정수·NUL 패딩·바이트 길이를 정확히 다룹니다.
4. 성공 fixture를 쉽게 작성하되 프로토콜 오류를 성공으로 위장하지 않습니다.
5. 서버와 PC의 지원 기능을 분리 조회하고 저장 전 미리보기를 제공합니다.
6. 기존 MCP 도구를 확장하고 신규 도구는 전송 없는 mock_preview 하나로 제한합니다.
7. 기존 v1 정의·리소스 스코프·시크릿·승인·UNKNOWN 안전성을 유지합니다.

heartbeat·요청 없는 TCP server push는 현재 확인한 통신사 커넥터에 필요하지 않으므로 이번 개발 범위에서 제외합니다. 별도 실제 규격이 확보되면 후속 요청으로 다룹니다.
