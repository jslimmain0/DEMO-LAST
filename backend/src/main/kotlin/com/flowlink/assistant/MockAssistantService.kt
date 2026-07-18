package com.flowlink.assistant

import com.fasterxml.jackson.databind.JsonNode
import com.flowlink.common.json.JsonService
import org.springframework.stereotype.Service

/**
 * 자연어 → Mock 서버 spec 어시스턴트. 플로우 어시스턴트(AssistantService)의 LLM 파이프라인
 * (Copilot 자격·벌크헤드·SSRF·429·JSON 추출)을 재사용하고, 시스템 프롬프트만 MockSchemaPrompt 로 바꾼다.
 * 자격이 없으면 키워드 기반 stub spec 으로 키 없이도 기능이 완결된다.
 */
@Service
class MockAssistantService(
    private val assistant: AssistantService,
    private val json: JsonService,
    private val skills: SkillService,
) {
    private val mapper = json.mapper()

    fun chat(req: MockAssistantChatRequest): MockAssistantChatResponse {
        val messages = assistant.normalizeMessages(req.messages)
        val system = buildSystemPrompt(req.spec)
        val completion = assistant.complete(messages, system, req.model) ?: return stub(messages)
        val (reply, spec) = assistant.parseModelJson(completion.text, "spec")
        return MockAssistantChatResponse(reply = reply, spec = spec, stub = false, model = completion.model)
    }

    private fun buildSystemPrompt(spec: JsonNode?): String = buildString {
        append(MockSchemaPrompt.SYSTEM)
        append(skills.promptBlock()) // 팀 지침 공유
        append("\n\n## CURRENT MOCK SPEC (edit this, keep route ids)\n")
        append(if (spec == null || spec.isNull) "(빈 spec)" else clip(json.toJson(spec), 16000))
    }

    private fun clip(s: String, max: Int): String = if (s.length <= max) s else s.substring(0, max) + "…(생략)"

    // --- stub(자격 없음) 모드 — 키워드로 결정적 샘플 spec ---

    private fun stub(messages: List<ChatMessage>): MockAssistantChatResponse {
        val q = messages.last().content.lowercase()
        val hint = "\n\n(⚠ AI 키/Copilot 미연결로 샘플 spec 을 생성했습니다. Copilot 을 연결하면 요청대로 만들어 줍니다.)"
        val (reply, sjson) = when {
            has(q, "결제", "payment", "pay", "콜백", "callback", "노티") ->
                "결제창(HTML)을 띄우고 returnUrl 로 콜백하는 샘플 mock 입니다." to STUB_PAY
            has(q, "tcp", "소켓", "socket", "전문") ->
                "고정길이 TCP 전문을 받아 앞 4바이트를 응답코드로 에코하는 샘플 mock 입니다." to STUB_TCP
            has(q, "otp", "상태", "state", "승인", "단계") ->
                "1차 pending → 2차 approved 로 상태가 바뀌는 샘플 mock 입니다." to STUB_STATE
            else ->
                "GET /ping 이 200 JSON 을 주는 기본 샘플 mock 입니다. 원하는 경로/응답을 더 구체적으로 말해 주세요." to STUB_JSON
        }
        val spec = try { mapper.readTree(sjson) } catch (e: Exception) { null }
        return MockAssistantChatResponse(reply + hint, spec, stub = true, model = "stub")
    }

    private fun has(q: String, vararg keys: String) = keys.any { q.contains(it) }

    companion object {
        private val STUB_JSON = """
        {"routes":[{"id":"r1","method":"GET","path":"/ping","rules":[
          {"id":"u1","status":200,"contentType":"json","body":"{\"ok\":true,\"seq\":\"{{seq}}\"}"}
        ]}]}""".trimIndent()

        private val STUB_PAY = """
        {"routes":[
          {"id":"pay","method":"POST","path":"/pay/checkout","rules":[
            {"id":"p1","status":200,"contentType":"html","body":"<!doctype html><meta charset=utf-8><body style=text-align:center;padding-top:40px><h2>결제창</h2><form id=f method=post action='{{body.returnUrl}}'><input type=hidden name=resultCode value=0000><input type=hidden name=tid value=T{{seq}}></form><button onclick=f.submit()>결제 승인</button></body>"}
          ]}
        ]}""".trimIndent()

        private val STUB_STATE = """
        {"routes":[{"id":"ord","method":"GET","path":"/order/status","rules":[
          {"id":"a","repeat":1,"status":200,"contentType":"json","body":"{\"status\":\"pending\"}","setState":[{"key":"status","value":"approved","op":"set"}]},
          {"id":"b","status":200,"contentType":"json","body":"{\"status\":\"{{state.status}}\"}"}
        ]}]}""".trimIndent()

        private val STUB_TCP = """
        {"tcp":{"enabled":true,"port":9091,"charset":"EUC-KR","prefixLength":4,"prefixIncludesSelf":false,
          "rules":[{"id":"t1","contains":"","response":"0000{{req:4:20}}"}]}}""".trimIndent()
    }
}
