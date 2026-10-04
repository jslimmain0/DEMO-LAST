package com.flowlink.assistant

import com.fasterxml.jackson.databind.JsonNode
import com.flowlink.common.json.JsonService
import com.flowlink.protocol.ProtocolSpec
import org.springframework.stereotype.Service

data class ProtocolAssistantChatRequest(
    val messages: List<ChatMessage> = emptyList(),
    val spec: JsonNode? = null,
    val model: String? = null,
)

data class ProtocolAssistantChatResponse(
    val reply: String,
    val spec: JsonNode?,
    val stub: Boolean,
    val model: String,
)

/**
 * 자연어/명세서 표 → 프로토콜(ProtocolSpec) 어시스턴트. 플로우·Mock 어시스턴트와 같은 LLM 파이프라인(AssistantService)을
 * 쓰고 시스템 프롬프트만 ProtocolSchemaPrompt. 모델이 준 spec 은 저장 전에 검증해 문제를 reply 에 덧붙인다(적용은 사용자 판단).
 * 자격이 없으면 샘플 프로토콜(stub)로 기능이 완결된다.
 */
@Service
class ProtocolAssistantService(
    private val assistant: AssistantService,
    private val json: JsonService,
    private val skills: SkillService,
) {
    fun chat(req: ProtocolAssistantChatRequest): ProtocolAssistantChatResponse {
        val messages = assistant.normalizeMessages(req.messages)
        val system = buildString {
            append(ProtocolSchemaPrompt.SYSTEM)
            append(skills.promptBlock())
            append("\n\n## CURRENT PROTOCOL SPEC (edit this, keep keys/names)\n")
            append(if (req.spec == null || req.spec.isNull) "(빈 spec)" else json.toJson(req.spec).take(16000))
        }
        val completion = assistant.complete(messages, system, req.model) ?: return stub(messages)
        val (reply, spec) = assistant.parseModelJson(completion.text, "spec")
        return ProtocolAssistantChatResponse(annotate(reply, spec), spec, stub = false, model = completion.model)
    }

    /** 제안 spec 을 검증해 오류를 reply 에 덧붙인다 — 적용 전에 사용자가 본다. */
    private fun annotate(reply: String, spec: JsonNode?): String {
        if (spec == null || spec.isNull) return reply
        val errs = try { json.mapper().treeToValue(spec, ProtocolSpec::class.java).validate() } catch (e: Exception) { listOf("spec 파싱 실패: ${e.message}") }
        return if (errs.isEmpty()) reply else reply + "\n\n⚠ 검증: " + errs.joinToString(" · ")
    }

    private fun stub(messages: List<ChatMessage>): ProtocolAssistantChatResponse {
        val spec = try { json.mapper().readTree(STUB) } catch (e: Exception) { null }
        return ProtocolAssistantChatResponse(
            "잔액조회(0210/0211) 샘플 프로토콜입니다 — 헤더 전문길이4·거래코드4, EUC-KR.\n\n(⚠ Copilot 미연결로 샘플을 생성했습니다. GitHub 로그인(Copilot 연결)을 하면 붙여넣은 명세서를 그대로 변환해 줍니다.)",
            spec, stub = true, model = "stub",
        )
    }

    companion object {
        private val STUB = """
        {"encoding":"EUC-KR","lengthField":"전문길이","lengthFormat":"ascii-decimal","endian":"big","includesSelf":false,"discriminator":"거래코드",
         "header":[{"name":"전문길이","len":4,"type":"length","pad":"left/zero"},{"name":"거래코드","len":4,"type":"ascii","pad":"right/space"}],
         "messages":[
          {"key":"0210","label":"잔액조회 요청","fields":[{"name":"계좌번호","len":13,"type":"ascii","pad":"right/space"},{"name":"고객명","len":20,"type":"string","pad":"right/space"},{"name":"금액","len":15,"type":"numeric","pad":"left/zero"}]},
          {"key":"0211","label":"잔액조회 응답","fields":[{"name":"응답코드","len":4,"type":"ascii","pad":"right/space"},{"name":"잔액","len":15,"type":"numeric","pad":"left/zero"},{"name":"최종거래일","len":8,"type":"ascii","pad":"none"}]}],
         "messagePlugins":[]}""".trimIndent()
    }
}
