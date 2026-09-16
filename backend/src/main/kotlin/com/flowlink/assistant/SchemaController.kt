package com.flowlink.assistant

import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController

/**
 * 스키마 레퍼런스 공개 — 어시스턴트 시스템 프롬프트(플로우/Mock/프로토콜 JSON 규격)를 외부 에이전트(MCP)도 같은 원문으로 읽는다.
 * 비밀 없음(규격 설명뿐)이라 무인증. 규격이 바뀌면 프롬프트 하나만 고치면 앱 AI 와 MCP 가 같이 따라온다.
 */
@RestController
class SchemaController {
    @GetMapping("/api/v1/schemas")
    fun schemas(): Map<String, String> = mapOf(
        "flow" to FlowSchemaPrompt.SYSTEM,
        "mock" to MockSchemaPrompt.SYSTEM,
        "protocol" to ProtocolSchemaPrompt.SYSTEM,
        "rules" to AGENT_RULES,
    )

    companion object {
        /** 에이전트가 소스 코드에서 워크플로/프로토콜/Mock 을 만들 때 지킬 규약 — 코드에 없는 값은 지어내지 않는다. */
        const val AGENT_RULES: String = """
# FlowLink 에이전트 규약
1. 코드에서 확인되지 않는 값(계좌번호·키·유효한 시나리오 순서)은 지어내지 않는다. 값 자리는 토큰으로 비워 둔다:
   - 환경마다 다른 값 → {{ 키@env }} (env_put 으로 환경 변수 등록 가능)
   - 비밀 → {{ 이름@secret }} (시크릿 볼트는 사용자가 화면에서 채운다)
   - 실행마다 사람이 넣는 값(OTP 등) → input 노드 → {{ 키@입력노드id }}
2. 확인이 필요한 자리마다 옆에 note(메모) 노드를 두고 "확인 필요: …" 로 적는다. 사용자는 워크플로 페이지에서 메모만 훑는다.
3. 외부 시스템 호출(대외 전문·타 서비스 API)은 Mock 으로 먼저 세운다: TCP 는 protocol_upsert → mock_upsert(type=TCP, protocolId) → 워크플로 TCP 노드의 host:port 를 mock 으로,
   HTTP 는 mock_upsert(type=HTTP) → HTTP 노드 baseUrl 을 mock base URL 로.
4. 만든 뒤 반드시 flow_run 으로 실행하고, 실패하면 execution_get / mock_log 로 원인을 보고 고친다. 결과는 "돌아가는 초안 + 확인 목록(메모)" 이다.
5. 워크플로에는 START 와 END 가 있어야 하고, 검증은 assert 노드(예: {{ 응답코드@노드 }} == '0000')로 남긴다.
"""
    }
}
