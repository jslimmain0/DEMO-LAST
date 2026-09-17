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
        "plugin" to pluginGuide(),
    )

    /** 스크립트 플러그인 작성 규격 — 화면 편집기와 MCP 가 같은 원문. fl 매니페스트는 코드에서 생성(추가 시 자동 반영). */
    private fun pluginGuide(): String = buildString {
        append(PLUGIN_GUIDE)
        append("\n## fl.* 헬퍼\n")
        for (e in com.flowlink.plugin.script.FlApi.MANIFEST) append("- `${e.signature}` — ${e.doc}. 예: `${e.example}`\n")
    }

    companion object {
        /** 스크립트 플러그인 작성 규격 — 화면 편집기와 MCP 가 같은 원문. fl 매니페스트는 코드에서 생성(추가 시 자동 반영). */
        const val PLUGIN_GUIDE: String = """
# 스크립트 플러그인(JS) 작성 규격
스크립트의 **마지막 표현식이 플러그인 객체**다. 샌드박스: 표준 JS + `fl.*` 만(Java/파일/네트워크 없음), 호출당 2초.
저장은 화면(/plugins) 에서 초안 → 승인 요청 → 관리자 승인 후에만 레지스트리에 올라간다(MCP 로는 만들 수 없음 — 사용자에게 안내).

변환(transform):  ({ id, label, description?, inputs?: [{key,label,type?}], outputs?: [{key,label,type?}], params?: [{key,label,type?,defaultValue?,options?,placeholder?}], apply(inputs, config) { return { 출력키: 값 } } })
필드 코덱:        ({ id, label, kind: 'fieldCodec', params?, encode(value, ctx) { return 문자열 }, decode(value, ctx) { return 문자열 } })
전문 코덱:        ({ id, label, kind: 'messageCodec', params?, encode(bytes, ctx) { return 바이트배열 }, decode(bytes, ctx) { return 바이트배열 } })
ctx = { config, direction: 'send'|'recv', field: {name,len,type,pad}|null, message: {필드명: 값} }. id 는 [a-z0-9-] 1~64자(소문자·숫자·하이픈, 첫 글자는 하이픈 불가).
"""

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
4. 만든 뒤 반드시 실행·확인한다. 워크플로는 flow_run(실패 시 execution_get / mock_log 로 원인). Mock 은 HTTP=http_request 로
   그 mock 의 base URL+경로를 호출해 응답을 보고, TCP=mock_send 로 전문을 보낸다. wait 콜백·웹훅도 http_request 로 쏜다.
   **curl·파이썬·셸로 직접 쏘지 말고 http_request/mock_send 를 써라**(그게 이 서버에 붙어 있는 경로다). 결과는 "돌아가는 초안 + 확인 목록(메모)".
5. 워크플로에는 START 와 END 가 있어야 하고, 검증은 assert 노드(예: {{ 응답코드@노드 }} == '0000')로 남긴다.
6. TRANSFORM 노드(transformId)나 Mock 코덱(codec step id)을 쓰려면 plugin_list 로 사용 가능한 플러그인 id·파라미터를 먼저 확인한다.
   목록에 없는 id 는 지어내지 말고, 없으면 TRANSFORM 노드·코덱을 만들지 않는다(플러그인은 화면 /plugins 에서 JS 로 작성해 관리자 승인 — 규격은 flowlink_guide(plugin), 사용자에게 안내한다).
"""
    }
}
