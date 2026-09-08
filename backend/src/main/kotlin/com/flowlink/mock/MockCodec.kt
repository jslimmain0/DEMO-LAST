package com.flowlink.mock

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.flowlink.mock.MockHttp.MockRequest
import com.flowlink.mock.MockSpec.MockCodecStep
import com.flowlink.transform.FlowTransform
import java.nio.charset.StandardCharsets
import java.util.LinkedHashMap
import java.util.Locale

/**
 * Mock 전문 코덱 v2 — 요청 전문이 들어오기 전(request)·응답 전문이 나가기 전(response)에 변환 플러그인([FlowTransform])을
 * 단계별로 적용한다. 순수(플러그인 조회는 람다 주입).
 *
 * 단계마다 **적용 범위**(target)가 있다:
 *  - `body`  : 전문 전체(문자열) — 같은 target 의 단계끼리 체인.
 *  - `fields`: 지정 필드 값만 — HTTP 는 JSON(점 경로)/urlencoded 키, TCP 는 레이아웃/응답 필드명. 필드가 없으면 건너뜀.
 *  - `header`: HTTP 헤더 — 요청 전엔 그 헤더 값을 변환, 응답 후엔 **본문을 입력으로 결과를 그 헤더에 기록**(서명 패턴).
 * 단계의 **입력 포트**는 mode=message(대상 값) 하나 + mode=value(템플릿 — `{{ key@secret }}`·요청 값) 나머지, 파라미터도 템플릿.
 * 실패(플러그인 없음·예외·출력 없음)는 [CodecException] — 조용한 빈 문자열 대신 명시 실패.
 */
object MockCodec {

    class CodecException(message: String, cause: Throwable? = null) : RuntimeException(message, cause)

    /** 코덱 시험/미리보기용 단계별 기록. */
    data class StepTrace(val index: Int, val id: String, val target: String, val field: String?, val input: String, val output: String)

    /** 유효 코덱 — 라우트에 codec 이 있으면 통째로 라우트 것, 없으면 서버 것. */
    @JvmStatic
    fun effective(server: MockSpec.MockCodec?, route: MockSpec.MockCodec?): MockSpec.MockCodec? = route ?: server

    // ---------- 단일 단계 ----------

    /** 한 단계를 값 하나에 적용 — 입력 포트(message/value)·파라미터를 문맥으로 렌더해 플러그인 호출. */
    @JvmStatic
    fun applyStep(step: MockCodecStep, index: Int, message: String, ctx: MockContext, lookup: (String) -> FlowTransform?): String {
        val id = step.id?.trim().orEmpty()
        if (id.isEmpty()) return message // 빈 단계(편집 중 미선택)는 통과
        val t = lookup(id) ?: throw CodecException("코덱 ${index + 1}단계: 알 수 없는 변환 플러그인 '$id'")
        val ports = t.inputs().map { it.key }.ifEmpty { listOf("input") }
        val inputs = LinkedHashMap<String, String>()
        val declared = step.inputs?.filter { !it.key.isNullOrBlank() } ?: emptyList()
        val messagePort = declared.firstOrNull { (it.mode ?: "value").equals("message", ignoreCase = true) }?.key?.trim()
            ?: step.inputKey?.takeIf { it.isNotBlank() }?.trim()
            ?: ports.first()
        for (p in ports) inputs[p] = ""
        for (d in declared) {
            val k = d.key!!.trim()
            if ((d.mode ?: "value").equals("message", ignoreCase = true)) continue
            inputs[k] = MockTemplate.render(d.value ?: "", ctx)
        }
        inputs[messagePort] = message
        val config = LinkedHashMap<String, String>()
        for (kv in step.config ?: emptyList()) {
            val k = kv.key ?: continue
            config[k] = MockTemplate.render(kv.value ?: "", ctx)
        }
        val outKey = step.outputKey?.takeIf { it.isNotBlank() } ?: t.outputs().firstOrNull()?.key ?: "result"
        val out = try {
            t.apply(inputs, config)
        } catch (e: Exception) {
            throw CodecException("코덱 ${index + 1}단계('$id') 실패: ${e.message ?: e.toString()}", e)
        }
        return out[outKey] ?: out.values.firstOrNull()
            ?: throw CodecException("코덱 ${index + 1}단계('$id'): 출력 '$outKey' 없음")
    }

    /**
     * v1 호환 — 단계들을 문자열 하나에 순서대로 적용(target 무시, 전부 body 취급). 문맥 없음(시크릿 없음).
     */
    @JvmStatic
    fun run(steps: List<MockCodecStep>?, text: String, lookup: (String) -> FlowTransform?): String =
        runValue(steps, text, MockContext(), lookup)

    /** 문자열 하나에 body 취급으로 체인(TCP 전체 전문 등). */
    @JvmStatic
    fun runValue(steps: List<MockCodecStep>?, text: String, ctx: MockContext, lookup: (String) -> FlowTransform?, trace: MutableList<StepTrace>? = null, target: String = "body"): String {
        if (steps.isNullOrEmpty()) return text
        var cur = text
        for ((i, step) in steps.withIndex()) {
            val before = cur
            cur = applyStep(step, i, cur, ctx, lookup)
            trace?.add(StepTrace(i, step.id ?: "", target, null, before, cur))
        }
        return cur
    }

    // ---------- HTTP ----------

    private fun isJson(contentType: String?, body: String): Boolean {
        val ct = contentType?.lowercase(Locale.ROOT) ?: ""
        if (ct.contains("json")) return true
        if (ct.contains("urlencoded") || ct.contains("form")) return false
        val t = body.trim()
        return t.startsWith("{") || t.startsWith("[")
    }

    /**
     * HTTP 요청 전 — 단계 순서대로 body/fields/header 를 갱신한 [MockRequest]. fields 는 본문 구조(JSON/urlencoded)를
     * 파싱해 값만 바꾸고 재직렬화(bodyFields 도 재계산).
     */
    @JvmStatic
    fun applyRequest(steps: List<MockCodecStep>?, req: MockRequest, ctx: MockContext, lookup: (String) -> FlowTransform?, json: ObjectMapper, trace: MutableList<StepTrace>? = null): MockRequest {
        if (steps.isNullOrEmpty()) return req
        val ct = req.headers.getOrDefault("content-type", "")
        val headers = LinkedHashMap(req.headers)
        var body = req.bodyText
        var cur = req
        for ((i, step) in steps.withIndex()) {
            val c = ctx.withReq(cur)
            when (step.targetOrBody()) {
                "fields" -> body = applyFields(step, i, body, ct, c, lookup, json, trace)
                "header" -> {
                    val name = step.header?.trim()?.lowercase(Locale.ROOT).orEmpty()
                    if (name.isEmpty()) throw CodecException("코덱 ${i + 1}단계: 대상 헤더 이름이 비었습니다.")
                    val v = headers[name] ?: continue
                    val out = applyStep(step, i, v, c, lookup)
                    trace?.add(StepTrace(i, step.id ?: "", "header", name, v, out))
                    headers[name] = out
                }
                else -> {
                    val out = applyStep(step, i, body, c, lookup)
                    trace?.add(StepTrace(i, step.id ?: "", "body", null, body, out))
                    body = out
                }
            }
            cur = MockRequest(req.method, req.path, req.query, headers, body, MockHttp.parseBodyFields(body, ct, MockHttp.charsetFromContentType(ct), json))
        }
        return cur
    }

    /**
     * HTTP 응답 후 — 렌더된 본문에 단계를 적용하고 결과 본문을 돌려준다(headers 는 header 대상 단계가 직접 기록).
     * [contentType] 은 규칙의 축약/mime — fields 대상 파싱 방식 결정.
     */
    @JvmStatic
    fun applyResponse(steps: List<MockCodecStep>?, rendered: String, headers: MutableMap<String, String>, contentType: String?, ctx: MockContext, lookup: (String) -> FlowTransform?, json: ObjectMapper, trace: MutableList<StepTrace>? = null): String {
        if (steps.isNullOrEmpty()) return rendered
        var body = rendered
        for ((i, step) in steps.withIndex()) {
            when (step.targetOrBody()) {
                "fields" -> body = applyFields(step, i, body, contentType, ctx, lookup, json, trace)
                "header" -> {
                    val name = step.header?.trim().orEmpty()
                    if (name.isEmpty()) throw CodecException("코덱 ${i + 1}단계: 대상 헤더 이름이 비었습니다.")
                    val out = applyStep(step, i, body, ctx, lookup)
                    trace?.add(StepTrace(i, step.id ?: "", "header", name, body, out))
                    headers[name] = out
                }
                else -> {
                    val out = applyStep(step, i, body, ctx, lookup)
                    trace?.add(StepTrace(i, step.id ?: "", "body", null, body, out))
                    body = out
                }
            }
        }
        return body
    }

    /** fields 대상 — JSON(점 경로) 또는 urlencoded 키의 값만 변환해 재직렬화. 없는 필드는 건너뜀. */
    private fun applyFields(step: MockCodecStep, i: Int, body: String, contentType: String?, ctx: MockContext, lookup: (String) -> FlowTransform?, json: ObjectMapper, trace: MutableList<StepTrace>?): String {
        val fields = step.fieldsOrEmpty()
        if (fields.isEmpty()) return body
        if (body.isBlank()) return body
        if (isJson(contentType, body)) {
            val root: JsonNode = try { json.readTree(body) } catch (e: Exception) {
                throw CodecException("코덱 ${i + 1}단계: 본문이 JSON 이 아니어서 필드 대상 코덱을 적용할 수 없습니다.")
            } ?: return body
            var changed = false
            for (f in fields) {
                val node = MockTemplate.JsonPaths.get(root, f) ?: continue
                val v = if (node.isValueNode) node.asText() else node.toString()
                val out = applyStep(step, i, v, ctx, lookup)
                trace?.add(StepTrace(i, step.id ?: "", "fields", f, v, out))
                if (MockTemplate.JsonPaths.setText(root, f, out)) changed = true
            }
            return if (changed) json.writeValueAsString(root) else body
        }
        val ct = contentType?.lowercase(Locale.ROOT) ?: ""
        if (ct.isEmpty() || ct.contains("urlencoded") || ct.contains("form") || body.contains("=")) {
            val map = MockHttp.parseUrlEncoded(body, StandardCharsets.UTF_8)
            var changed = false
            for (f in fields) {
                val v = map[f] ?: continue
                val out = applyStep(step, i, v, ctx, lookup)
                trace?.add(StepTrace(i, step.id ?: "", "fields", f, v, out))
                map[f] = out; changed = true
            }
            return if (changed) MockHttp.toUrlEncoded(ArrayList(map.entries)) else body
        }
        throw CodecException("코덱 ${i + 1}단계: 필드 대상 코덱은 JSON/urlencoded 본문에만 적용됩니다(contentType=$contentType).")
    }

    // ---------- TCP ----------

    /** TCP 응답 필드 값 하나 — target=fields 단계 중 이 필드를 포함한 단계만 순서대로. */
    @JvmStatic
    fun applyTcpField(steps: List<MockCodecStep>?, field: String, value: String, ctx: MockContext, lookup: (String) -> FlowTransform?, trace: MutableList<StepTrace>? = null): String {
        if (steps.isNullOrEmpty()) return value
        var cur = value
        for ((i, step) in steps.withIndex()) {
            if (step.targetOrBody() != "fields" || field !in step.fieldsOrEmpty()) continue
            val out = applyStep(step, i, cur, ctx, lookup)
            trace?.add(StepTrace(i, step.id ?: "", "fields", field, cur, out))
            cur = out
        }
        return cur
    }

    /** TCP 전문 전체 — target=body 단계만 순서대로. */
    @JvmStatic
    fun applyTcpBody(steps: List<MockCodecStep>?, text: String, ctx: MockContext, lookup: (String) -> FlowTransform?, trace: MutableList<StepTrace>? = null): String {
        if (steps.isNullOrEmpty()) return text
        var cur = text
        for ((i, step) in steps.withIndex()) {
            if (step.targetOrBody() != "body") continue
            val out = applyStep(step, i, cur, ctx, lookup)
            trace?.add(StepTrace(i, step.id ?: "", "body", null, cur, out))
            cur = out
        }
        return cur
    }
}
