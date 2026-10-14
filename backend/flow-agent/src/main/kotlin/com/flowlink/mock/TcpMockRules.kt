package com.flowlink.mock

import com.flowlink.protocol.ProtocolCompiler
import java.util.Locale
import java.util.regex.Pattern

/** 실제 Mock과 전송 없는 미리보기의 동일 업무 규칙·템플릿 경로. */
object TcpMockRules {
    fun match(rules: List<MockSpec.MockTcpRule>, values: Map<String, String>, resolve: (String) -> String = { it }): MockSpec.MockTcpRule? =
        rules.firstOrNull { rule -> rule.whenOrEmpty().all { pass(it, values, resolve) } }

    fun responseFields(header: Map<String, String>, templates: Map<String, String>, context: MockContext, strict: Boolean = false): LinkedHashMap<String, String> = LinkedHashMap(header).also { fields ->
        for ((name, template) in templates) {
            if (strict) Regex("\\{\\{\\s*([^{}]+?)\\s*}}").findAll(template).forEach { match ->
                val token = match.groupValues[1].trim()
                val source = if ('@' in token) token.substringAfterLast('@') else token.substringBefore('.')
                val key = if ('@' in token) token.substringBeforeLast('@').trim() else token.substringAfter('.', "")
                val available = when (source) {
                    "req" -> key in context.tcpFields
                    "secret" -> key in context.secrets
                    "env" -> key in context.env
                    "state" -> key in context.state
                    else -> token in setOf("uuid", "seq") || com.flowlink.common.text.NowTokens.resolveExpr(token) != null
                }
                if (!available) throw ProtocolCompiler.ProtocolFailure("MISSING_CONTEXT_FIELD", "then.fields.$name", "응답 템플릿의 필수 컨텍스트 필드가 없습니다.")
            }
            fields[name] = MockTemplate.render(template, context)
        }
    }

    private fun pass(condition: MockSpec.MockTcpCond, values: Map<String, String>, resolve: (String) -> String): Boolean {
        val field = condition.field?.trim().orEmpty()
        if (field.isEmpty()) return true
        val actual = values[field]?.trim() ?: return false
        val value = resolve(condition.value.orEmpty())
        return when (condition.op?.lowercase(Locale.ROOT) ?: "eq") {
            "eq" -> actual == value.trim()
            "ne" -> actual != value.trim()
            "contains" -> actual.contains(value)
            "startswith" -> actual.startsWith(value.trim())
            "endswith" -> actual.endsWith(value.trim())
            "regex" -> try { Pattern.compile(value).matcher(actual).find() } catch (_: Exception) { false }
            "exists" -> actual.isNotEmpty()
            else -> actual == value.trim()
        }
    }
}
