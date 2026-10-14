package com.flowlink.assistant

/** Examples are compiled by contract tests; the UI assistant and MCP read this same source. */
object TcpV2Guide {
    const val PROTOCOL_EXAMPLE = """{"schemaVersion":2,"encoding":"UTF-8","header":[{"name":"code","len":2,"type":"ascii","pad":"none"},{"name":"tid","len":9,"type":"ascii","pad":"none"}],"messages":[{"key":"F1:request","fields":[{"name":"phone","len":12,"type":"ascii","pad":"right/nul"}]},{"key":"F1:response","fields":[{"name":"result","len":2,"type":"ascii","pad":"none"},{"name":"phone","len":12,"type":"ascii","pad":"right/nul"}]}],"transactions":[{"key":"auth","when":[{"field":"code","op":"eq","value":"F1"}],"requestMessage":"F1:request","responseMessage":"F1:response","framing":{"mode":"fixed","fixedLength":23},"responseFraming":{"mode":"fixed","fixedLength":25},"requestAck":null,"responseAck":null}],"transport":{"connection":"execution","idleTimeoutMs":30000}}"""
    const val HTTP_EXAMPLE = """{"routes":[{"id":"pay","method":"POST","path":"/pay","rules":[{"id":"ok","status":200,"contentType":"json","body":"{\"result\":\"00\",\"tid\":\"{{body.tid}}\"}"}]}]}"""

    val SYSTEM = """
## TCP v2 · 공통 컴파일·전송 없는 확인
기존 schemaVersion 없는 정의는 v1이며 자동 변경하지 않는다. v2는 schemaVersion=2와 transactions를 선언한다.
transactions와 ackMessages는 ProtocolSpec에만 둔다. MockSpec.tcp에는 중복 저장하지 않고 protocolId로 참조한다.
공통 header를 먼저 읽고 transactions[].when의 헤더 eq AND 조건으로 거래를 하나 선택한 후 그 거래의 framing/responseFraming으로 요청/응답을 읽는다.
거래의 framing/responseFraming이 전역보다 우선한다. 미매칭/복수 매칭/조건 중복은 오류이며 첫 거래·최대 길이로 추정하지 않는다.
거래 key, when, requestMessage, responseMessage, requestAck, responseAck는 필수다. ACK가 없으면 null을 명시한다.
프레이밍 mode는 length/fixed/delimiter이며 기존 lengthAdjustment/includesSelf/lengthFormat/endian 계약을 재사용한다.
v2와 transport.requestAckHex/responseAckHex를 함께 쓰지 않는다. 연결 정책 transport.connection=once/execution, idleTimeoutMs=1000~3600000은 공통이다.

ACK 객체 = {send:{kind:hex,hex:...} 또는 {kind:message,messageKey:...,values:{...}},receive:{kind:exact,hex:...} 또는 {kind:length-only,lengthBytes:N} 또는 {kind:fields,messageKey:...,expected:{...}},timeoutMs:1~120000}.
send/receive 둘 다 필수이며 바이트 길이는 같아야 하고 1~1024B이다. requestAck는 client가 receive/mock이 send, responseAck는 client가 send/mock이 receive를 사용한다.
length-only도 실제 N바이트를 누적 수신하고 EOF/timeout은 실패한다. null 단계 생략과 혼동하지 않으며 ACK를 업무 규칙으로 만들지 않는다.
ackMessages = [{key,encoding?,fields:[Field...]}]는 독립 레이아웃으로 업무 header를 붙이지 않는다.
send.values와 receive.expected는 상수 또는 {{req.필드}}/{{res.필드}}를 받는다. requestAck에서 아직 없는 res 참조는 오류다. 없는 필수 바인딩을 빈 값으로 대체하지 않는다.
Field.type=integer는 ASCII numeric과 다르며 len=1/2/4/8, endian=big/little, signed=true/false를 지정한다. 8B 값은 정밀도 손실 없는 10진 문자열로 입출력한다.
pad=right/nul 또는 left/nul은 NUL 바이트다. 공백과 구분한다. EUC-KR 등 문자셋의 바이트 초과를 자동 절단하지 않는다.

protocol_upsert(dryRun=true)는 저장 없이 공통 컴파일한다. protocol_preview(action=assemble|parse,transactionKey,phase=request|requestAck|response|responseAck)는 wire/fieldOffsets/length/validations를 반환한다.
v1은 key가 필수다. v2 transactionKey가 있으면 key 생략 가능하며 key를 함께 주면 같은 phase의 전문이어야 한다.
phase 생략은 기존 frameDirection/direction으로 업무 request/response를 고른다. 명시 phase=request는 frameDirection=send, response는 recv만 가능하다.
ACK phase는 transactionKey가 필수이고 frameDirection을 같이 주지 않는다. direction은 코덱 컨텍스트이고 assemble 기본 send/parse 기본 recv이다.
parse는 bytesB64가 필수이며 정확히 완전한 한 프레임을 준다. assemble에는 bytesB64를 주지 않는다. spec/protocolId/name 중 하나만 선택한다.
ACK/응답 컨텍스트는 requestFields/responseFields로 전달한다. 시크릿은 text/HEX/Base64/필드 모두 마스킹하며 바이트 수·오프셋은 유지한다.

## TCP Mock 전체 구조와 응답 규칙
MockSpec.tcp={port:Int,protocolId:String?,upstream:String?,timeoutMs:Int?,rules:[{id:String,when:[{field:String,op:String,value:String?}],then:{mode:mock|proxy,fields:{응답필드:템플릿}},fault?:{delayMs?,splitAt?,drop?,reset?,corruptLength?}}]}.
port는 PC 1024~65535, 서버는 capabilities.limits의 할당 범위를 따른다. protocolId를 아직 고르지 않은 초안은 리스너를 시작하지 않는다.
timeoutMs 기본 5000. 규칙은 정의 순서의 첫 일치이며 when 생략/빈 배열은 기본 규칙이다. op는 eq(기본)/ne/contains/startswith/endswith/regex/exists다.
then.mode는 mock(기본)/proxy이며 fields 값은 문자열이다. proxy는 upstream host:port가 필수이며 명시된 실제 실행에만 전송한다.
응답 기본은 요청 헤더 에코이고 then.fields로 덮어쓴다. v2는 선택 거래의 responseMessage를 조립하며 다른 전문 키를 임의 대입하지 않는다.
TCP 템플릿은 {{req.필드}}, {{today}}(yyyyMMdd), {{time}}(HHmmss), {{now}}(ISO UTC), {{now:yyyyMMddHHmmss}}(기본 KST, @UTC 지정 가능), {{uuid}}, {{seq}}, {{ 이름@secret }}, {{ 키@env }}를 사용한다.
규격 밖 거래·필수 필드·암호 오류를 성공 응답으로 위장하지 않는다.
성공 fixture는 명시적인 규칙·업무 성공코드·요청 거래번호/금액 참조를 작성하는 편의다. 합성 개인정보·승인번호는 테스트용임을 표시하고 수정 가능하게 한다. 실제 OTP/PASS/SMS 성공을 주장하지 않는다.
저장: target/workspace는 Mock의 저장 위치, resourceWorkspaceId=public은 중앙 자원, envSource는 local/server 환경 출처, environment는 그 출처의 환경 이름이다. 다른 출처의 같은 이름 환경을 자동 병합하지 않는다.

mock_upsert(dryRun=true)는 전체 spec·프로토콜·승인 코덱·환경·시크릿 이름을 확인하되 저장·버전·리스너를 만들지 않는다. enabled=true여도 dryRun은 활성화하지 않는다.
mock_preview는 저장 slug 또는 미저장 spec+type과 request를 받는다. HTTP request={method,path,headers,query,body}, TCP={key,values} 또는 {bytesB64}다. URL 호출은 하지 않는다.
protocolSpec은 편집 중 전체 ProtocolSpec을 이 미리보기에서만 사용한다. 저장 정의를 덮어쓰지 않는다.
state/hits/seq는 읽은 snapshot과 virtualSeq를 결과에 표시하며 증가시키지 않는다. 콜백·상태 변경·외부 전송을 실행하지 않는다.
mock_send는 실제 1회 소켓 시험이다. 호출마다 연결을 종료하며 연결 유지 시험은 같은 흐름의 TCP 노드 둘을 쓴다.
v2는 transactionKey 또는 key를 사용하며 steps(REQUEST→REQUEST_ACK→RESPONSE→RESPONSE_ACK→COMPLETE), transactionKey, executionId를 반환한다. 생략 ACK는 SKIPPED이고 마지막 ACK 전 COMPLETE로 표시하지 않는다.
v2 Mock 시험 이력은 프로세스 메모리 최근 1000건·JSON 합계 32MB이며 재시작 후 조회할 수 없다. DB 워크플로 실행 이력과 별도다. UNKNOWN은 execution_get(executionId)으로 확인하고 자동 재전송하지 않는다.
flowlink_status.capabilities는 server/local의 실제 실행기 보고를 분리한다. supported/unsupported/unknown과 설치 버전·한도를 확인한다. 배포 manifest 버전으로 구형 PC 지원을 추정하지 않는다.
PORT_IN_USE·LOCAL_AGENT_OFFLINE·CAPABILITY_UNKNOWN·UNSUPPORTED_CAPABILITY·PLUGIN_NOT_APPROVED·ENVIRONMENT_NOT_FOUND·SECRET_NOT_FOUND는 원인을 해결한 후 명시적으로 다시 실행한다.
mock_tcp_sessions는 현재 거래·단계·누적 바이트를 보여주며 extend는 대기 중 유휴 기한만 연장한다. heartbeat를 보내지 않는다.

완전한 최소 ProtocolSpec v2 예시(합성, 실제 통신사 길이를 뜻하지 않음):
${PROTOCOL_EXAMPLE}
이를 저장한 실제 protocolId를 사용한 전체 MockSpec 예시(자리표시자는 실제 조회 id로 교체):
{"resourceWorkspaceId":"public","envSource":"local","tcp":{"port":9510,"protocolId":"<조회한 protocol id>","rules":[{"id":"ok","when":[{"field":"code","op":"eq","value":"F1"}],"then":{"mode":"mock","fields":{"result":"00","phone":"{{req.phone}}"}}}]}}
완전한 최소 HTTP MockSpec 예시:
${HTTP_EXAMPLE}
""".trimIndent()
}
