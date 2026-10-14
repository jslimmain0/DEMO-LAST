# Flowlink 통신사 Mock 기능 요청서

작성일: 2026-10-14

상태: 개발 요청 초안. **제안 필드와 동작은 현재 Flowlink 지원 기능이 아니다.**

대상 독자: Flowlink 서버·Windows 앱·TCP 엔진·화면 개발자.

## 목적과 범위

teledit이 사용하는 통신사 HTTP/TCP 연동을 Flowlink 로컬 Mock으로 쉽게 구성하고, 필요하면 팀 서버 공간에 공유한다.

기본 목표는 **정상 요청에 항상 성공 업무 응답을 반환하는 테스트용 Mock**이다. 정확한 ACK 검증은 선택 기능으로 제공한다. 성공 응답 모드라도 잘못된 프레임, 필수 필드 누락, 암호화 실패를 정상 처리로 위장하지 않는다.

여기서 “모든 Mock”은 이 저장소의 현재 통신사 연동을 의미한다. 통신사 공식 규격 전체, 알려지지 않은 전문, 실제 SMS/PASS 발송, 모든 앱 업무 검증의 성공을 보장한다는 뜻이 아니다.

개발 대상:

- 기존 ProtocolSpec·MockSpec·프레이머·직렬화기·승인 코덱을 확장한다.
- 서버와 Windows 앱에서 같은 규격·검증·실행 계획을 사용한다.
- 사용자는 한 통신사의 거래들을 가능하면 **하나의 Mock·하나의 접속 주소**에 등록한다.
- 화면과 MCP가 같은 기능을 제공한다. MCP만 지원하거나 화면에서만 가능한 설정을 만들지 않는다.

이번 버전 제외:

- heartbeat, 요청 없는 TCP 서버 선발송(server push), 연결 재시작 복구.
- 실제 통신사로 자동 프록시·재전송하는 동작.
- 새 암호 알고리즘이나 통신사 키를 임의로 생성하는 동작.
- teledit의 DB·가맹점·상품·OTP 검증을 우회하는 동작.

KT PASS HTTP Push 요청이나 LGU PASS Push 요청 거래는 “요청 없는 TCP 서버 선발송”과 다르며 범위에 포함한다.

## 현재 지원과 확인 한계

2026-10-14에 조회한 MCP 가이드와 저장소 소스를 기준으로 한다. Flowlink 구현 소스는 이 저장소에 없으므로 미문서화된 동작의 존재·부재를 확정하지 않는다.

| 구분 | 확인 내용 | 처리 |
|---|---|---|
| 기존 지원 | 길이 필드, 길이 보정, binary 길이, 고정 길이, 구분자, 요청·응답 경계 분리 | 재사용 |
| 기존 지원 | 고정 HEX 요청 ACK·응답 ACK, 동일 실행의 연결 재사용 | 재사용 |
| 기존 지원 | 승인된 필드·메시지·변환 코덱, 공통 시크릿 참조 | 재사용 |
| 기존 지원 | TCP 응답의 요청 필드 참조 `{{req.m3sTid}}` 등 | 재사용하고 가이드에 정식 명시 |
| 명세에 미확인 | ACK 내용을 비교하지 않고 일정 길이만 수신하는 설정 | 기존 엔진 확인 후 노출 또는 구현 |
| 명세에 미확인 | 요청 기반 ACK 조립·필드별 ACK 검증 | 확장 제안 |
| 명세에 미확인 | 동일 리스너의 거래별 수신 길이·ACK 단계 선택 | 확장 제안 |
| 안내 부족 | `flowlink_guide(mock)` 본문이 HTTP 전용으로 안내 | TCP 전체 스키마를 추가 |

**정정 사항:** 고정 길이 ACK 수신을 반드시 새로 개발해야 한다고 단정하지 않는다. 먼저 현재 엔진이 마지막 ACK를 수신·처리·종료하는지 확인한다. 이미 가능하면 설정·문서·MCP 노출만 추가한다.

SKT의 현재 앱 코드는 접수 ACK를 47B 읽을 뿐 내용을 검증하지 않는다. 따라서 고정 접수 ACK로 성공 테스트를 구성할 여지가 있다. 마지막 ACK 처리는 실소켓 검증 없이 성공 또는 실패로 확정하지 않는다.

## 통신사별 적용 범위

| 대상 | 전송 특성 | 적용 요구사항 |
|---|---|---|
| SKT | 47B 헤더, offset 43의 4B big-endian 본문 길이, 4-way | ACK 길이 수신, binary 정수, 선택적 동적 ACK |
| KT TCP | 6B 외부 길이 + SEED/Base64 봉투, ACK 없음 | 기존 메시지 코덱·길이 계산 재사용 |
| LGU | 75B 헤더에 길이 필드 없음, 거래별 길이·ACK 차이 | 거래 선택 후 고정 길이 적용, 거래별 ACK |
| CJH | 헤더 50B를 제외한 선언 길이 | 기존 `lengthAdjustment: 50` 적용 |
| SKL·KCT·MNC | 현재 MVNO 전송 경로는 요청·응답형 | 통신사별 길이·응답 필드 설정 확인 |
| KPNC 인증 | 요청 450B / 응답 250B, ACK 없음 | 기존 요청·응답별 고정 길이 |
| KT SMS GW·Common SMS·IIPS·CUPI, LGU Offline VAN | HTTP 요청·응답 | 기존 HTTP 규칙·템플릿·코덱 재사용 |

LGU 길이 표는 현재 요청 DTO와 전송 컨텍스트 기준이다. 모두 헤더를 포함한다.

| 거래 | 코드 | 요청 B | 응답 B | 응답 후 클라이언트 ACK |
|---|---|---:|---:|---|
| 일반 인증 | F1 | 137 | 270 | 없음 |
| 일반 결제 | G1 | 624 | 266 | 30B |
| 일반 취소 | H1 | 263 | 129 | 30B |
| PASS 이용동의 인증 | V1 | 243 | 268 | 없음 |
| PASS Push 요청 | Y1 | 244 | 128 | 없음 |
| PASS 이용동의 확인 | M1 | 243 | 268 | 없음 |
| PASS Push 결과 확인 | Z1 | 141 | 128 | 없음 |
| PASS 결제 | W1 | 387 | 257 | 30B |
| PASS 취소 | X1 | 264 | 130 | 30B |

LGU T1/U1은 Exchange에 선언되어 있으나 해당 메서드별 HandshakeContext가 현재 코드에 명시되지 않는다. 요청·응답 길이와 실제 전송 동작을 추가 확정한 뒤 등록한다. 임의로 위 거래의 길이·ACK 설정을 상속하지 않는다.

SKT 일반 결제와 취소는 현재 Exchange의 명령 코드가 모두 `0320`이다. **거래 코드 하나만으로 모든 전문을 구분할 수 있다고 가정하지 않는다.** 헤더의 본문 길이 등 추가 식별 정보가 충분한지 확인하고, 불충분하면 실제 규격상의 구분 조건을 확보한다.

## 기능 요구사항

우선순위 P0는 성공 응답용 Mock과 안전한 제작에 필요하고, P1은 정확한 프로토콜 재현을 위한 확장이다.

| ID | 우선순위 | 요청 기능 | 완료 조건 |
|---|---|---|---|
| F01 | P0 | 거래별 프레임·ACK 설정 | LGU 거래들을 같은 포트에서 처리 |
| F02 | P0 | ACK 고정 길이 수신 모드 | 47B/30B 수신 후 내용 비교 없이 다음 단계 진행 |
| F03 | P0 | binary 정수·NUL 패딩 지원 또는 기존 기능 노출 | SKT int4 및 ACK의 NUL 바이트를 정확히 조립 |
| F04 | P0 | 성공 응답 작성 지원 | 요청 참조·필수 필드·성공 코드가 명시된 fixture 생성 |
| F05 | P0 | 저장 전 통합 검증·미리보기 | 프레임·규칙·코덱·ACK 계획을 전송 없이 확인 |
| F06 | P0 | 실행 단계 진단과 지원 기능 조회 | 오류 단계와 서버/PC 지원 여부를 구분 |
| F07 | P1 | 요청 기반 ACK 조립·필드 검증 | 임의 거래번호로 SKT/LGU ACK 생성·검증 |
| F08 | P0 | 연결 주소·자원 의존성 안내 | 앱 설정에 사용할 실제 주소와 필요한 승인·시크릿 표시 |

### F01. 헤더 기반 거래 선택과 거래별 전송 설정

1. 고정된 공통 헤더를 먼저 읽고 필요한 필드만 파싱한다.
2. 선언된 거래 선택 조건으로 거래를 하나 결정한다.
3. 선택한 거래의 요청 프레이밍으로 나머지를 읽는다.
4. 그 거래의 응답 전문·응답 프레이밍·ACK 단계를 적용한다.

요청 전체를 읽은 뒤에 거래를 구분하면 LGU에서는 수신 길이를 알 수 없으므로 적용 순서가 중요하다.

- 조건은 우선 헤더 필드의 `eq` AND 조합만 지원한다. 임의 스크립트 조건은 필요 없다.
- 식별에 본문이 필요하면 읽을 수 있는 공통 prefix와 공식 구분 규칙을 별도로 정의해야 한다. 이번 헤더 선택 기능이 이를 자동 추측하지 않는다.
- 조건 중복·미매칭·둘 이상의 후보는 명시적 오류다. 첫 후보 또는 가장 큰 길이로 조용히 대체하지 않는다.
- 거래별 요청·응답 프레이밍은 기존 length/fixed/delimiter 모델을 재사용한다.
- 미지원 전문을 성공 응답으로 처리하지 않는다.

### F02. 내용 검증 없는 ACK 수신

기존 HEX 일치 수신에 `length-only` 수신 방식을 추가하거나 기존 구현을 노출한다.

- SKT 47B, LGU 결제·취소 30B처럼 선언된 길이만 읽는다.
- ACK 내용 일치 검사는 하지 않지만 수신 길이·시간 제한은 검사한다.
- 일부 바이트만 수신하면 누적한다. EOF, timeout, 연결 중단을 성공으로 처리하지 않는다.
- ACK와 다음 프레임이 같은 socket read에 들어오면 필요한 바이트만 소비하고 나머지는 보존한다.
- ACK를 업무 요청으로 다시 해석하지 않는다.
- 마지막 ACK를 받기 전에 소켓을 닫지 않는다. `connection=execution`이면 ACK 완료 후 다음 거래 대기로 복귀한다.
- ACK 속성 자체가 `null`인 단계 생략과 실제 수신 후 내용만 무시하는 `length-only`를 구분한다. 별도의 `kind=none`은 추가하지 않는다.

SKT 성공 fixture는 기존 고정 47B 접수 ACK 송신과 이 수신 방식의 조합으로 구성할 수 있다. 앱이 접수 ACK 내용 검증을 도입하면 F07을 적용한다.

### F03. 숫자와 패딩

SKT의 `msgType`, `msgId`, `result`, `msgLen`은 ASCII 숫자가 아닌 binary int4다.

- 일반 binary 정수 필드는 1/2/4/8B, endian, signed 여부를 명시한다.
- ASCII 숫자 `numeric`의 기존 의미는 변경하지 않는다.
- 정수 범위 초과, 소수, 문자열 파싱 실패는 오류다.
- 8B 정수는 JavaScript 정밀도 손실 없이 정규화된 10진 문자열로 입출력한다.
- 공백과 NUL 패딩을 구분한다. 특히 ACK 생성기는 NUL을 공백으로 바꾸지 않는다.
- 문자열 길이는 EUC-KR 등의 **바이트 길이**로 검사한다. 넘치는 문자를 자동 잘라 성공 처리하지 않는다.

이미 필드 코덱으로 표현 가능하면 해당 메커니즘을 재사용한다. 단순 int/NUL 처리를 위해 통신사마다 별도 JS 플러그인을 요구하지 않는 작성 UX를 제공한다.

### F04. 성공 fixture 작성

화면에서 `성공 응답용`과 `프로토콜 검증용` 작성 모드를 제공한다. 엔진의 무조건 성공 스위치가 아니라 **명시적인 규칙·필드·ACK 설정을 생성하는 작성 편의 기능**이다.

- 거래별 요청·응답 전문, 성공 코드, 필수 응답 필드를 등록한다.
- 거래번호·전화번호·금액 등 필요한 값은 요청 참조로 반환한다.
- 합성 회원정보·한도·승인번호는 테스트 fixture임을 표시하고 사용자가 수정할 수 있게 한다.
- 거래번호·금액을 무엇이든 같은 상수로 반환해 앱 검증을 우연히 통과시키지 않는다.
- 암호화 요청을 해석할 필요가 없으면 불투명 필드(opaque)로 받아 복호화·검증을 생략할 수 있다.
- 암호화 응답이나 요청 평문 해석이 필요하면 기존 승인 코덱과 시크릿을 사용한다.
- OTP/PASS 실제 사용자 동작이 필요한 앱 흐름을 자동 성공했다고 표시하지 않는다.
- HTTP의 기존 응답 규칙·상태·카운터·콜백을 재사용한다. 새로운 별도 시나리오 엔진은 만들지 않는다.

### F05. 저장 전 검증과 미리보기

단일 컴파일·조립 경로를 화면, MCP, 실제 런타임에서 공유한다.

- 길이 합계, 응답 키 존재, 조건 중복, ACK 길이, 템플릿 필드, 코덱 종류를 검증한다.
- 코덱 처리 후 실제 wire 길이와 선언 길이를 확인한다. 평문 길이와 wire 길이를 혼동하지 않는다.
- 예시 요청으로 매칭 규칙, 거래, 응답 필드, 네 단계 송수신 계획을 보여준다.
- 미리보기는 저장·리스너 시작·실제 전송·상태 변경을 하지 않는다.
- 미매칭 필수 바인딩은 빈 문자열로 대체하지 않고 경로와 함께 오류를 반환한다.
- 기존 템플릿 동작을 일괄 변경하지 않는다. v2의 필수 필드 검증과 v1의 기존 동작을 구분한다.
- 시크릿·민감 필드는 텍스트/HEX/Base64/필드 어디에서도 원문을 반환하지 않는다.
- 시크릿 마스킹이 있어도 바이트 수·필드 위치·검증 결과는 반환한다.

### F06. 단계별 진단

최소 단계:

`REQUEST → REQUEST_ACK → RESPONSE → RESPONSE_ACK → COMPLETE`

각 단계에서 역할(client/mock), 송수신 방향, 예상·실제 바이트 수, 선택 거래, 소요 시간, 결과, 안전한 오류 정보를 남긴다. ACK 없는 단계는 `SKIPPED`로 표시한다.

진단 출력의 phase는 대문자 단계 이름을 사용한다. protocol_preview 입력의 소문자 phase와는 별도 enum이며 명시적으로 대응한다.

지원 기능 조회는 서버와 연결된 PC를 분리한다. 서버 버전이나 Windows 배포 manifest만으로 실제 PC의 기능을 지원한다고 추정하지 않는다.

### F07. 선택적 동적 ACK

성공 fixture에는 필수가 아니지만 정확한 재현을 위해 구조화 ACK를 선택할 수 있게 한다.

- ACK를 업무 전문과 별도 레이아웃으로 정의한다. LGU ACK 30B에 업무 헤더 75B를 자동 붙이지 않는다.
- 송신 ACK 필드와 수신 expected 값은 해당 거래의 `req`/`res`에서 바인딩한다. requestAck는 req만 참조할 수 있고, responseAck는 req/res를 참조할 수 있다.
- 수신 검증은 전체 HEX 일치 또는 지정 필드 비교 중 하나를 선택한다.
- SKT 클라이언트 응답 ACK는 47B이고 요청의 sourceId/destId/msgId/m3sTid와 상수 필드를 사용한다.
- LGU 클라이언트 응답 ACK는 `00  ` 4B + 거래번호 9B + `V001` 4B + 전화번호 12B + NUL 1B다.
- 통신사가 보내는 SKT 접수 ACK의 정확한 방향·필드 규칙은 별도로 확정한다. 클라이언트 ACK 레이아웃이 같다는 이유만으로 송신자/수신자를 추측하지 않는다.
- 컨텍스트는 연결·거래에 격리하고 종료·취소·실패 시 해제한다.

### F08. 로컬 연결과 의존성

- 생성 결과에 저장 위치, 실제 리스너 위치, 활성 상태, 접속 주소, 환경 출처를 각각 표시한다.
- HTTP는 서비스 클라이언트가 바로 사용할 canonical base URL과 API path를 분리해서 반환한다.
- hostname 리다이렉트나 API path 중복 때문에 접속이 실패하지 않도록 실제 주소를 안내한다.
- 포트 충돌, 오프라인 PC, 서버 연결 필요, 플러그인 승인 대기, 시크릿 이름 누락을 구분한다.
- 활성화 전 검증 실패 시 기존 정상 리스너를 유지한다. 포트 교체는 가능하면 새 리스너 준비 후 전환하고, 불가능한 중단은 명시한다.
- 현재 자원 스코프를 자동 public 전환하거나 private 자원을 복사하지 않는다.

## 제안 데이터 모델

**아래는 v2 확장 제안이다. 현행 MCP에 그대로 전송할 수 없다.** 예시는 부분 스키마이며 header/messages 등이 생략되어 있다. transactions와 ackMessages는 ProtocolSpec에만 저장하고 Mock은 tcp.protocolId로 참조한다.

### ProtocolSpec 확장

```json
{
  "schemaVersion": 2,
  "transactions": [
    {
      "key": "lgu-auth",
      "when": [{"field": "protocolCode", "op": "eq", "value": "F1"}],
      "requestMessage": "F1:request",
      "responseMessage": "F1:response",
      "framing": {"mode": "fixed", "fixedLength": 137},
      "responseFraming": {"mode": "fixed", "fixedLength": 270},
      "requestAck": null,
      "responseAck": null
    },
    {
      "key": "lgu-bill",
      "when": [{"field": "protocolCode", "op": "eq", "value": "G1"}],
      "requestMessage": "G1:request",
      "responseMessage": "G1:response",
      "framing": {"mode": "fixed", "fixedLength": 624},
      "responseFraming": {"mode": "fixed", "fixedLength": 266},
      "requestAck": null,
      "responseAck": {
        "send": {
          "kind": "message",
          "messageKey": "lgu-response-ack",
          "values": {
            "prefix": "00  ",
            "m3sTid": "{{req.m3sTid}}",
            "version": "V001",
            "phone": "{{req.phone}}",
            "filler": "00"
          }
        },
        "receive": {"kind": "length-only", "lengthBytes": 30},
        "timeoutMs": 3000
      }
    }
  ]
}
```

규칙:

- `transactions`이 없으면 v1의 discriminator·프레이밍·고정 ACK 동작을 유지한다.
- v2에 `transactions`가 있으면 `when`으로 업무 전문 키를 선택한다. v1 discriminator에 임의 키를 억지로 대입하지 않는다.
- 프레이밍은 거래별 값이 전역 값보다 우선한다. 둘 다 없으면 검증 실패이며 최대 길이를 추정하지 않는다.
- ACK는 거래에 `null`이면 해당 단계 없음, 객체이면 명시된 단계 있음이다. v2 거래는 두 ACK 속성을 필수로 선언하여 상속 모호성을 없앤다.
- 연결 정책·유휴 제한은 기존 protocol.transport를 재사용한다.
- legacy `requestAckHex`/`responseAckHex`와 거래별 ACK를 함께 지정하면 충돌 오류다.
- Mock의 기존 `tcp.rules[].when/then`은 응답 업무 규칙으로 유지하고, 거래 선택·프레이밍을 대신하지 않는다.
- 기존 `then.fields`와 선택 거래의 responseMessage로 응답을 조립한다. 거래별 다른 응답 키가 필요한 경우 별도 거래 정의로 명시한다.

### ACK 정의와 역할

ACK 객체는 송신 방법과 수신 방법을 분리한다.

| 속성 | 허용 제안 | 의미 |
|---|---|---|
| `send.kind` | `hex` / `message` | 고정 HEX 또는 별도 ACK 레이아웃 조립 |
| `receive.kind` | `exact` / `length-only` / `fields` | 고정 HEX 일치 / 길이만 수신 / 지정 필드 검증 |
| `timeoutMs` | 양의 정수, 서버 제한 내 | ACK 단계의 수신 시간 제한 |

같은 정의를 클라이언트와 Mock 양쪽이 사용한다.

| 단계 | 클라이언트 역할 | Mock 역할 |
|---|---|---|
| requestAck | `receive` 사용 | `send` 사용 |
| responseAck | `send` 사용 | `receive` 사용 |

각 ACK 객체의 send/receive는 둘 다 필수다. `exact`는 `hex`, `fields`는 `messageKey`와 `expected`, `length-only`는 `lengthBytes`를 받는다. 송신 bytes 길이와 수신 계약의 길이가 같아야 한다. 기존 ACK 상한 1024B를 유지한다.

expected는 필드 이름별 상수 또는 `{{req.필드}}`/`{{res.필드}}` 바인딩 객체다. send.values와 같은 타입·패딩 정규화 규칙으로 비교하며, 필수 바인딩 누락은 오류다. 단계상 아직 없는 res를 requestAck에서 참조하면 컴파일 오류다.

이 구조라면 LGU Mock은 ACK 내용을 무시해도 Flowlink 클라이언트는 거래값으로 ACK를 생성해서 보낼 수 있다.

예시의 send.kind=message는 P1 기능을 사용한다. P0만 제공하는 성공 fixture에서는 상대가 ACK 내용을 검증하지 않는 조건으로 같은 길이의 고정 send.kind=hex를 사용할 수 있다. 구조화 송신이 없는 실행기에 message를 조용히 hex로 바꾸지는 않는다.

`ackMessages`는 업무 header와 무관한 독립 필드 배열이다.

```json
{
  "ackMessages": [
    {
      "key": "lgu-response-ack",
      "encoding": "EUC-KR",
      "fields": [
        {"name": "prefix", "len": 4, "type": "ascii", "pad": "none"},
        {"name": "m3sTid", "len": 9, "type": "ascii", "pad": "right/nul"},
        {"name": "version", "len": 4, "type": "ascii", "pad": "none"},
        {"name": "phone", "len": 12, "type": "ascii", "pad": "right/nul"},
        {"name": "filler", "len": 1, "type": "binary", "pad": "none"}
      ]
    }
  ]
}
```

SKT int4 필드의 제안 예:

```json
{
  "name": "msgId",
  "len": 4,
  "type": "integer",
  "endian": "big",
  "signed": true
}
```

`integer`, `right/nul`, `ackMessages`, `transactions` 모두 신규 제안이다. 기존 binary HEX 필드나 승인 필드 코덱으로 이미 구현 가능한 기능은 재사용하되 입력 계약은 한 가지로 문서화한다.

## 구현 순서와 호환성

1. **기존 엔진 확인:** SKT 고정 접수 ACK + 실제 앱 응답 ACK 송신을 재현하여 F02의 기존 지원 여부를 판단한다.
2. **공통 모델·컴파일러:** 거래 선택, ACK 모델, 필드 직렬화, 길이·의존성 검증을 추가한다.
3. **런타임:** 서버·PC Mock·TCP 노드·Mock 테스트가 같은 실행 계획을 사용한다.
4. **작성·확인 UX:** 성공 fixture, 저장 전 미리보기, 주소·지원 기능·오류 표시를 추가한다.
5. **MCP:** 관련 스키마와 가이드, 미리보기, 실행 출력을 동시에 공개한다.
6. **정밀 ACK:** P1 필드 검증을 추가하고 통신사별 확인된 ACK 규격만 배포한다.

호환성 원칙:

- 기존 schemaVersion 없는 정의를 v1로 취급하고 자동 마이그레이션하지 않는다.
- 새 서버 + 구형 PC 조합은 지원하지 않는 v2 실행을 전송 전에 거절한다. 정의를 v1로 조용히 축소하지 않는다.
- 기능 배포와 기존 정의 변경을 분리한다. 사용 중 Mock은 사용자가 새 버전을 저장할 때까지 기존 동작을 유지한다.
- protocol·Mock·승인 코덱 버전을 실행 동안 고정한다.
- 시크릿 값, resourceIdentity, 관리 토큰은 저장·공유 입력에 복사하지 않는다.
- local/server 환경은 독립적이고 조회 실패를 빈 환경으로 대체하지 않는다.
- UNKNOWN·접수 불명확 결과는 조회로 확인하고 자동 재실행하지 않는다.

## 인수 기준

| ID | 확인 항목 | 기대 결과 |
|---|---|---|
| A01 | 기존 KT·MVNO·HTTP Mock 재실행 | 기존 wire·규칙·코덱 동작 유지 |
| A02 | SKT 성공 fixture, 서로 다른 두 거래번호 | 고정 접수 ACK, 정상 응답, 각 마지막 47B ACK를 읽고 정상 종료 |
| A03 | SKT 마지막 ACK를 1B/나머지로 분할 전송 | 누적 수신 후 완료, 조기 종료 없음 |
| A04 | ACK와 다음 요청을 한 write로 전송 | ACK 길이만 소비하고 다음 요청 바이트 보존 |
| A05 | ACK 미수신·부분 수신 후 EOF | timeout/EOF 실패, 업무 성공과 전송 완료를 별도로 표시 |
| A06 | LGU F1/G1/H1을 같은 포트에 순차 연결 | 137/624/263B 요청 구분, 270/266/129B 응답, ACK 단계 차이 적용 |
| A07 | LGU PASS 표의 각 거래 | 해당 길이·ACK 유무 적용 |
| A08 | SKT 중복 명령 코드·모호한 조건 | 미매칭/모호성 오류, 임의 거래 선택 없음 |
| A09 | strict ACK의 거래번호 또는 msgType 변경 | 필드 불일치 실패. length-only 모드와 결과가 구분됨 |
| A10 | CJH 선언 400B / 실제 요청 450B | 보정 +50 적용. 선언 200B / 응답 250B도 동일 |
| A11 | KPNC 요청 450B / 응답 250B | 독립 프레이밍으로 정상 완료 |
| A12 | int4 값 4·130, NUL filler, 한글 경계 | big-endian bytes·패딩·바이트 길이가 기대값과 일치 |
| A13 | 미리보기·실행에 같은 합성 요청 사용 | 선택 거래·wire 길이·ACK 계획 일치 |
| A14 | 시크릿을 사용하는 KT 코덱 | bytes·필드·오류·로그의 원문 노출 없음 |
| A15 | 미승인 코덱·없는 환경·구형 PC·포트 충돌 | 각각 원인 구분, 기존 리스너 보존, 재전송 없음 |
| A16 | 성공 fixture의 금액·거래번호 변경 | 필요한 응답 값이 요청을 따름. 미지원 거래는 성공 처리하지 않음 |
| A17 | ACK 완료 후 execution 연결 재사용 | 다음 거래 대기로 복귀. 한번 호출과 장기 연결 정책을 혼동하지 않음 |

인수는 로컬 합성 데이터·테스트 클라이언트로 진행한다. 실제 통신사·실제 사용자의 SMS/PASS 요청은 자동 실행하지 않는다.

전송 시험 통과와 teledit 전체 업무 성공은 별도 결과로 기록한다. T1/U1·키 발급 거래처럼 규격이 덜 확인된 거래는 미검증 목록으로 남긴다.

## 소스 근거

기준 경로: `carrier-network-connector\src\main\java\kr\co\danal\network\carrier`

| 파일 | 위치 | 확인한 내용 |
|---|---|---|
| `socket\exchange\spec\skt\protocol\SktRequestHeader.java` | 28–65 | 47B 헤더, int4, 동적 클라이언트 ACK |
| `socket\exchange\transport\skt\SktSocketTransport.java` | 46–91 | 요청 ACK 내용 미검증, 4-way, 매 요청 소켓 |
| `socket\exchange\SktCarrierExchange.java` | 93–127 | 결제·취소 동일 코드, 요청 기반 ACK 컨텍스트 |
| `socket\exchange\LguCarrierExchange.java` | 43–152 | 거래 코드, 응답 길이, ACK 유무 |
| `socket\exchange\spec\lgu\protocol\LguHeaderProtocol.java` | 12–59 | 75B 헤더, 길이 필드 없음 |
| `socket\exchange\spec\lgu\LguBillRequest.java` | 74–102 | 요청 624B, 동적 30B ACK |
| `socket\exchange\spec\lgu\LguAuthRequest.java` | 14–45 | 요청 137B |
| `socket\exchange\spec\lgu\LguCancelRequest.java` | 22–57 | 요청 263B, ACK |
| `socket\exchange\spec\lgu\LguPassOptinAuthRequest.java` | 29–59 | 요청 243B |
| `socket\exchange\spec\lgu\LguPassOptinPushRequest.java` | 29–59 | 요청 244B |
| `socket\exchange\spec\lgu\LguPassOptinConfirmRequest.java` | 29–59 | 요청 243B |
| `socket\exchange\spec\lgu\LguPassPushConfirmRequest.java` | 28–44 | 요청 141B |
| `socket\exchange\spec\lgu\LguPassBillRequest.java` | 34–100 | 요청 387B, ACK |
| `socket\exchange\spec\lgu\LguPassCancelRequest.java` | 32–76 | 요청 264B, ACK |
| `socket\exchange\spec\kpnc\KpncAuthRequest.java` | 6–12 | 요청 450B |
| `socket\exchange\spec\kpnc\KpncAuthResponse.java` | 6–14 | 응답 250B |
| `http\exchange\KtIipsHttpExchange.java` | 25–35 | PASS Push는 HTTP 호출 |

Flowlink 근거는 현재 MCP의 `flowlink_guide(protocol/mock/nodes/plugin)`, `mock_get`, `flowlink_status` 조회 결과다. 공개 가이드의 기능 계약과 실제 구현 소스 검증을 구분한다.
