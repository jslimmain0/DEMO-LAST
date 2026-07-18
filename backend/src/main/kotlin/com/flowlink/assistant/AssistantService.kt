package com.flowlink.assistant

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ArrayNode
import com.fasterxml.jackson.databind.node.ObjectNode
import com.flowlink.common.error.BadRequestException
import com.flowlink.common.error.TooManyRequestsException
import com.flowlink.common.json.JsonService
import com.flowlink.execution.engine.SsrfGuard
import com.flowlink.secret.SecretService
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Service
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit

/**
 * 자연어 → 플로우 어시스턴트. Claude(Anthropic Messages API)에 현재 그래프 + 스키마 프롬프트를 주고
 * `{reply, graph}` 를 받아 캔버스에 적용 가능한 FlowGraph 를 반환한다.
 *
 * 키(env/yml 또는 시크릿 볼트 `anthropic-api-key`)가 없으면 **stub 모드**로 키워드 기반 샘플 플로우를 만들어
 * 키 없이도 기능이 완결된다(데모/오프라인). SSRF 가드는 api.anthropic.com 을 통과한다.
 */
@Service
class AssistantService(
    private val props: AssistantProperties,
    private val json: JsonService,
    private val secretService: SecretService,
    private val ssrfGuard: SsrfGuard,
) {
    private val log = LoggerFactory.getLogger(AssistantService::class.java)
    private val mapper: ObjectMapper = json.mapper()
    private val http: HttpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()
    /** 동시 LLM 호출 벌크헤드 — 느린 업스트림이 Tomcat 요청 스레드를 고갈시키지 않게 상한. */
    private val gate = Semaphore(props.maxConcurrent)

    /** env/yml 우선, 없으면 시크릿 볼트의 anthropic-api-key. 요청 스레드(TenantContext)에서만 호출. */
    private fun resolveKey(): String? {
        props.apiKey?.let { return it }
        return try {
            secretService.activeSecrets(null)["anthropic-api-key"]?.takeIf { it.isNotBlank() }
        } catch (e: Exception) {
            log.debug("시크릿 볼트 키 조회 실패(무시): {}", e.message); null
        }
    }

    fun config(): AssistantConfig {
        val real = resolveKey() != null
        return AssistantConfig(available = true, usingRealLlm = real, model = if (real) props.model else "stub")
    }

    fun chat(req: AssistantChatRequest): AssistantChatResponse {
        val messages = req.messages.filter { it.role == "user" || it.role == "assistant" }
            .dropWhile { it.role != "user" } // Anthropic: 첫 메시지는 user 여야
        if (messages.isEmpty() || messages.last().role != "user") {
            throw BadRequestException("보낼 메시지가 없습니다.")
        }
        val key = resolveKey() ?: return stub(messages, req.graph)
        return callAnthropic(key, messages, req.graph)
    }

    // --- 실제 LLM 호출 ---

    private fun callAnthropic(key: String, messages: List<ChatMessage>, graph: JsonNode?): AssistantChatResponse {
        // 벌크헤드 — 동시 호출 상한 초과면 429(요청 스레드가 느린 업스트림에 고갈되지 않게)
        if (!gate.tryAcquire(2, TimeUnit.SECONDS)) {
            throw TooManyRequestsException("AI 요청이 많습니다. 잠시 후 다시 시도하세요.")
        }
        try {
            return callAnthropicInner(key, messages, graph)
        } finally {
            gate.release()
        }
    }

    private fun callAnthropicInner(key: String, messages: List<ChatMessage>, graph: JsonNode?): AssistantChatResponse {
        val uri = URI.create(props.baseUrl + "/v1/messages")
        try { ssrfGuard.check(uri) } catch (e: Exception) { throw BadRequestException("AI 엔드포인트가 차단됐습니다: ${e.message}") }

        // 시크릿 마스킹 — SET 노드의 secret=true 변수 값을 외부 LLM 에 평문으로 보내지 않는다.
        val ctxGraph = redactSecrets(graph)
        val system = buildString {
            append(FlowSchemaPrompt.SYSTEM)
            append("\n\n## CURRENT CANVAS (the user's current graph — edit this, keep ids)\n")
            append(if (ctxGraph == null || ctxGraph.isNull) "(빈 캔버스)" else clip(json.toJson(ctxGraph), 24000))
        }
        val body: ObjectNode = mapper.createObjectNode().apply {
            put("model", props.model)
            put("max_tokens", props.maxTokens)
            put("system", system)
            val arr: ArrayNode = putArray("messages")
            for (m in messages) arr.add(mapper.createObjectNode().put("role", m.role).put("content", m.content))
        }

        val request = HttpRequest.newBuilder(uri)
            .timeout(Duration.ofSeconds(90))
            .header("content-type", "application/json")
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01")
            .POST(HttpRequest.BodyPublishers.ofString(mapper.writeValueAsString(body)))
            .build()

        val res: HttpResponse<String> = try {
            http.send(request, HttpResponse.BodyHandlers.ofString())
        } catch (e: Exception) {
            throw BadRequestException("AI 호출 실패: ${e.message}")
        }
        if (res.statusCode() == 429) throw TooManyRequestsException("AI 요청이 많습니다. 잠시 후 다시 시도하세요.")
        if (res.statusCode() >= 400) {
            log.warn("Anthropic {} : {}", res.statusCode(), clip(res.body(), 500))
            val msg = extractErr(res.body()) ?: "상태 ${res.statusCode()}"
            throw BadRequestException("AI 호출 실패: $msg")
        }

        val text = extractText(res.body())
        val parsed = parseModelJson(text)
        return AssistantChatResponse(reply = parsed.first, graph = parsed.second, stub = false, model = props.model)
    }

    /** Anthropic 응답 content[].text 를 이어붙인다. */
    private fun extractText(bodyJson: String): String {
        return try {
            val root = mapper.readTree(bodyJson)
            val sb = StringBuilder()
            root.path("content").forEach { block ->
                if (block.path("type").asText() == "text") sb.append(block.path("text").asText())
            }
            sb.toString()
        } catch (e: Exception) { bodyJson }
    }

    private fun extractErr(bodyJson: String): String? =
        try { mapper.readTree(bodyJson).path("error").path("message").asText(null) } catch (e: Exception) { null }

    /**
     * 모델 텍스트에서 {reply, graph} JSON 을 추출. **균형 중괄호 스캐너**(문자열/이스케이프 인지)로
     * 첫 '{' 에서 짝이 맞는 '}' 까지만 잘라 중첩/문자열 내 중괄호에 견고. 코드펜스도 벗긴다.
     * 파싱 실패 시 전체 텍스트를 reply 로(그래프 없음) — 최소한 대화는 되게.
     */
    private fun parseModelJson(text: String): Pair<String, JsonNode?> {
        val cleaned = text.trim().removePrefix("```json").removePrefix("```").removeSuffix("```").trim()
        val jsonStr = extractJsonObject(cleaned)
        if (jsonStr != null) {
            try {
                val obj = mapper.readTree(jsonStr)
                val reply = obj.path("reply").asText("").ifBlank { "플로우를 준비했습니다." }
                val g = obj.get("graph")
                val graph = if (g == null || g.isNull || !g.isObject) null else g
                return reply to graph
            } catch (e: Exception) { /* fall through */ }
        }
        return (text.ifBlank { "응답을 이해하지 못했습니다." }) to null
    }

    /**
     * 외부 LLM 컨텍스트에서 SET 노드의 secret=true 변수 값을 마스킹(딥카피 후 변형 — 원본 불변).
     * ⚠ HTTP 헤더 등에 하드코딩한 토큰은 자동 감지 불가 — 시크릿 볼트(`{{ 이름@secret }}`) 사용 권장.
     */
    private fun redactSecrets(graph: JsonNode?): JsonNode? {
        if (graph == null || graph.isNull || !graph.isObject) return graph
        val copy = graph.deepCopy<JsonNode>()
        val nodes = copy.get("nodes")
        if (nodes != null && nodes.isArray) {
            for (node in nodes) {
                if (node.path("type").asText() != "set") continue
                val vars = node.get("vars") ?: continue
                if (!vars.isArray) continue
                for (v in vars) {
                    if (v is ObjectNode && v.path("secret").asBoolean(false) && v.has("value")) {
                        v.put("value", "***")
                    }
                }
            }
        }
        return copy
    }

    private fun clip(s: String, max: Int): String = if (s.length <= max) s else s.substring(0, max) + "…(생략)"

    // --- stub(키 없음) 모드 ---

    private fun stub(messages: List<ChatMessage>, graph: JsonNode?): AssistantChatResponse {
        val q = messages.last().content.lowercase()
        val hint = "\n\n(⚠ AI 키가 설정되지 않아 샘플 플로우를 생성했습니다. 시크릿 볼트에 `anthropic-api-key` 를 추가하거나 " +
            "FLOWLINK_ASSISTANT_API_KEY 를 설정하면 실제 AI 가 요청대로 만들어 줍니다.)"
        val (reply, gjson) = when {
            has(q, "결제", "payment", "pay", "콜백", "callback") ->
                "결제창을 열고 콜백을 기다렸다가 승인 여부로 분기하는 샘플 플로우입니다." to STUB_PAYMENT
            has(q, "otp", "인증", "입력", "input", "번호") ->
                "사용자 입력(OTP)을 받아 검증하는 샘플 플로우입니다." to STUB_INPUT
            has(q, "tcp", "소켓", "socket", "전문") ->
                "고정길이 TCP 전문을 보내고 응답을 잘라 쓰는 샘플 플로우입니다." to STUB_TCP
            has(q, "http", "api", "호출", "요청", "get", "post", "rest") ->
                "REST API 를 호출해 응답 상태를 검증하는 샘플 플로우입니다." to STUB_HTTP
            else ->
                "간단한 시작 → HTTP 호출 → 끝 샘플 플로우입니다. 원하는 흐름을 더 구체적으로 말해 주세요." to STUB_HTTP
        }
        val g = try { mapper.readTree(gjson) } catch (e: Exception) { null }
        return AssistantChatResponse(reply = reply + hint, graph = g, stub = true, model = "stub")
    }

    private fun has(q: String, vararg keys: String): Boolean = keys.any { q.contains(it) }

    companion object {
        /** 첫 '{' 에서 균형이 맞는 '}' 까지의 부분 문자열(문자열 리터럴·이스케이프 인지). 없으면 null. 순수·테스트용 internal. */
        internal fun extractJsonObject(text: String): String? {
            val start = text.indexOf('{')
            if (start < 0) return null
            var depth = 0
            var inStr = false
            var esc = false
            for (i in start until text.length) {
                val c = text[i]
                if (inStr) {
                    when {
                        esc -> esc = false
                        c == '\\' -> esc = true
                        c == '"' -> inStr = false
                    }
                } else {
                    when (c) {
                        '"' -> inStr = true
                        '{' -> depth++
                        '}' -> { depth--; if (depth == 0) return text.substring(start, i + 1) }
                    }
                }
            }
            return null
        }

        private val STUB_HTTP = """
        {"name":"HTTP 호출 샘플","nodes":[
          {"id":"start1","name":"시작","type":"start","cat":"start","x":40,"y":180},
          {"id":"http1","name":"API 호출","type":"http","cat":"generic","x":260,"y":180,"method":"GET","baseUrl":"http://localhost:18080/mock/demo","path":"/ping","bodyType":"json","respType":"json","reqMode":"server","charset":"UTF-8","fields":{"params":[],"headers":[],"body":[]},"outputs":[{"key":"data","type":"object"}]},
          {"id":"assert1","name":"상태 검증","type":"assert","cat":"assert","x":480,"y":180,"condition":"{{ httpStatus@http1 }} == 200"},
          {"id":"end1","name":"끝","type":"end","cat":"end","x":700,"y":180}
        ],"edges":[
          {"id":"e1","from":"start1","to":"http1"},
          {"id":"e2","from":"http1","to":"assert1"},
          {"id":"e3","from":"assert1","to":"end1"}
        ]}
        """.trimIndent()

        private val STUB_INPUT = """
        {"name":"OTP 입력 샘플","nodes":[
          {"id":"start1","name":"시작","type":"start","cat":"start","x":40,"y":180},
          {"id":"input1","name":"OTP 입력","type":"input","cat":"input","x":260,"y":180,"waitMsg":"휴대폰으로 받은 OTP 6자리를 입력하세요","waitFields":[{"id":"w1","key":"otp","label":"OTP 6자리","type":"string"}]},
          {"id":"if1","name":"검증","type":"if","cat":"if","x":480,"y":180,"condition":"{{ otp@input1 }} == '123456'"},
          {"id":"ok1","name":"성공","type":"set","cat":"set","x":700,"y":100,"vars":[{"id":"v1","key":"msg","value":"인증 성공","secret":false}]},
          {"id":"ng1","name":"실패","type":"set","cat":"set","x":700,"y":280,"vars":[{"id":"v1","key":"msg","value":"인증 실패","secret":false}]},
          {"id":"end1","name":"끝","type":"end","cat":"end","x":920,"y":180}
        ],"edges":[
          {"id":"e1","from":"start1","to":"input1"},
          {"id":"e2","from":"input1","to":"if1"},
          {"id":"e3","from":"if1","to":"ok1","fromPort":"true"},
          {"id":"e4","from":"if1","to":"ng1","fromPort":"false"},
          {"id":"e5","from":"ok1","to":"end1"},
          {"id":"e6","from":"ng1","to":"end1"}
        ]}
        """.trimIndent()

        private val STUB_PAYMENT = """
        {"name":"결제 콜백 샘플","nodes":[
          {"id":"start1","name":"시작","type":"start","cat":"start","x":40,"y":180},
          {"id":"set1","name":"주문 정보","type":"set","cat":"set","x":260,"y":180,"vars":[{"id":"v1","key":"orderId","value":"ORD-1001","secret":false},{"id":"v2","key":"amount","value":"48000","secret":false}]},
          {"id":"form1","name":"결제창 열기","type":"form","cat":"form","x":480,"y":180,"formAction":"http://localhost:18080/mock/demo/pay/checkout","formMethod":"POST","formDisplay":"popup","fields":{"params":[],"headers":[],"body":[{"id":"b1","key":"amount","value":"{{ amount@set1 }}"},{"id":"b2","key":"returnUrl","value":"{{ url@wait1 }}"}]},"outputs":[]},
          {"id":"wait1","name":"결제 콜백 대기","type":"wait","cat":"wait","x":700,"y":180,"waitTimeoutSec":180,"callbackRespType":"html","callbackRespBody":"<h2>결제가 완료되었습니다. 창을 닫아주세요.</h2>","outputs":[{"key":"resultCode","type":"string"},{"key":"tid","type":"string"}]},
          {"id":"if1","name":"승인 여부","type":"if","cat":"if","x":920,"y":180,"condition":"{{ resultCode@wait1 }} == '0000'"},
          {"id":"ok1","name":"승인 처리","type":"set","cat":"set","x":1140,"y":100,"vars":[{"id":"v1","key":"msg","value":"결제 승인","secret":false}]},
          {"id":"ng1","name":"거절 처리","type":"set","cat":"set","x":1140,"y":280,"vars":[{"id":"v1","key":"msg","value":"결제 거절","secret":false}]},
          {"id":"end1","name":"끝","type":"end","cat":"end","x":1360,"y":180}
        ],"edges":[
          {"id":"e1","from":"start1","to":"set1"},
          {"id":"e2","from":"set1","to":"form1"},
          {"id":"e3","from":"form1","to":"wait1"},
          {"id":"e4","from":"wait1","to":"if1"},
          {"id":"e5","from":"if1","to":"ok1","fromPort":"true"},
          {"id":"e6","from":"if1","to":"ng1","fromPort":"false"},
          {"id":"e7","from":"ok1","to":"end1"},
          {"id":"e8","from":"ng1","to":"end1"}
        ]}
        """.trimIndent()

        private val STUB_TCP = """
        {"name":"TCP 전문 샘플","nodes":[
          {"id":"start1","name":"시작","type":"start","cat":"start","x":40,"y":180},
          {"id":"tcp1","name":"전문 전송","type":"tcp","cat":"tcp","x":260,"y":180,"tcpHost":"127.0.0.1","tcpPort":9000,"tcpEncoding":"EUC-KR","tcpTimeoutMs":5000,"tcpPrefixLength":4,"tcpPrefixIncludesSelf":false,"tcpRequest":[{"id":"r1","name":"msgType","length":4,"value":"0012","pad":"right","padChar":" "},{"id":"r2","name":"custName","length":10,"value":"홍길동","pad":"right","padChar":" "}],"tcpResponse":[{"id":"o1","name":"result","length":4},{"id":"o2","name":"balance","length":12}],"outputs":[{"key":"result","type":"string"},{"key":"balance","type":"string"}]},
          {"id":"assert1","name":"결과 검증","type":"assert","cat":"assert","x":480,"y":180,"condition":"{{ result@tcp1 }} == '0000'"},
          {"id":"end1","name":"끝","type":"end","cat":"end","x":700,"y":180}
        ],"edges":[
          {"id":"e1","from":"start1","to":"tcp1"},
          {"id":"e2","from":"tcp1","to":"assert1"},
          {"id":"e3","from":"assert1","to":"end1"}
        ]}
        """.trimIndent()
    }
}
