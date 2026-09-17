package com.flowlink.plugin.script

import com.flowlink.codec.CodecCtx
import com.flowlink.plugin.PluginsProperties
import com.flowlink.transform.FlowTransform
import org.graalvm.polyglot.Context
import org.graalvm.polyglot.Engine
import org.graalvm.polyglot.HostAccess
import org.graalvm.polyglot.PolyglotAccess
import org.graalvm.polyglot.PolyglotException
import org.graalvm.polyglot.ResourceLimits
import org.graalvm.polyglot.Source
import org.graalvm.polyglot.Value
import org.graalvm.polyglot.io.IOAccess
import org.graalvm.polyglot.proxy.ProxyArray
import org.graalvm.polyglot.proxy.ProxyObject
import org.springframework.stereotype.Component
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * 스크립트 플러그인 런타임(GraalJS). 호출마다 새 Context(엔진 공유 — Context 는 동시 사용 불가, Mock/워커는 멀티스레드),
 * **호스트 접근 전면 차단** + `fl` 프록시만 주입, CPU 시간·문장 수 상한. 스크립트의 마지막 표현식 = 플러그인 객체.
 * ponytail: 호출당 Context 생성(1~3ms) — 핫패스 실측 후 풀링.
 */
@Component
class ScriptRuntime(private val props: PluginsProperties) {
    data class RunResult<T>(val value: T, val logs: List<String>, val durationMs: Long)

    private val engine: Engine = Engine.newBuilder("js").option("engine.WarnInterpreterOnly", "false").build()
    private val watchdog = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "flowlink-script-watchdog").apply { isDaemon = true } }

    fun compile(code: String, name: String = "plugin"): CompiledScript {
        val source = try { Source.newBuilder("js", code, "$name.js").build() } catch (e: Exception) { throw ScriptError(null, null, e.message ?: e.toString(), e) }
        val meta = withContext(mutableListOf()) { ctx -> readMeta(evalPlugin(ctx, source)) }.value
        return CompiledScript(meta, source)
    }

    fun runTransform(cs: CompiledScript, inputs: Map<String, String>, config: Map<String, String>): RunResult<Map<String, String>> =
        withContext(mutableListOf()) { ctx ->
            val plugin = evalPlugin(ctx, cs.source)
            val out = plugin.getMember("apply").execute(ProxyObject.fromMap(inputs), ProxyObject.fromMap(config))
            toStringMap(ctx, out)
        }

    fun runFieldCodec(cs: CompiledScript, value: String, fn: String, ctx: CodecCtx): RunResult<String> =
        withContext(mutableListOf()) { c ->
            val out = evalPlugin(c, cs.source).getMember(fn).execute(value, codecCtx(ctx))
            if (out.isNull) "" else FlHelpers.show(out)
        }

    fun runMessageCodec(cs: CompiledScript, fn: String, body: ByteArray, ctx: CodecCtx): RunResult<ByteArray> =
        withContext(mutableListOf()) { c ->
            val u8 = c.eval("js", "(a) => Uint8Array.from(a)").execute(ProxyArray.fromList(body.map { (it.toInt() and 0xff) as Any }))
            val out = evalPlugin(c, cs.source).getMember(fn).execute(u8, codecCtx(ctx))
            if (!out.hasArrayElements()) throw ScriptError(null, null, "$fn 는 Uint8Array(바이트 배열)를 돌려줘야 합니다")
            ByteArray(out.arraySize.toInt()) { i -> (out.getArrayElement(i.toLong()).asLong() and 0xff).toByte() }
        }

    // ---- 내부 ----

    private fun newContext(logs: MutableList<String>): Context {
        val ctx = Context.newBuilder("js")
            .engine(engine)
            .allowHostAccess(HostAccess.NONE)
            // allowHostClassLookup 을 (거짓만 돌려줘도) 호출하면 `Java` 전역 네임스페이스 자체가 생겨버린다(멤버 접근은
            // 막혀도 typeof Java === 'object') — 아예 호출하지 않아야 `Java`/`Packages` 가 정의되지 않는다.
            .allowIO(IOAccess.NONE)
            .allowCreateThread(false)
            .allowNativeAccess(false)
            .allowPolyglotAccess(PolyglotAccess.NONE)
            .allowExperimentalOptions(true) // js.java-package-globals 가 실험적 옵션이라 필요
            .option("js.ecmascript-version", "2022")
            .option("js.java-package-globals", "false") // 기본 true — java/javax/com/org 전역이 클래스 필터 없이도 JavaPackage 스텁으로 노출됨
            .resourceLimits(ResourceLimits.newBuilder().statementLimit(props.script.statementLimit, null).build())
            .build()
        ctx.getBindings("js").putMember("fl", FlHelpers.build(logs))
        return ctx
    }

    /** Context 생성 → 실행 → 항상 close. 타임아웃은 watchdog 이 close(true) 로 취소. 모든 Graal 예외를 ScriptError 로. */
    private fun <T> withContext(logs: MutableList<String>, block: (Context) -> T): RunResult<T> {
        val ctx = newContext(logs)
        val guard = watchdog.schedule({ runCatching { ctx.close(true) } }, props.script.timeoutMs, TimeUnit.MILLISECONDS)
        val t0 = System.nanoTime()
        try {
            val v = block(ctx)
            return RunResult(v, logs.toList(), (System.nanoTime() - t0) / 1_000_000)
        } catch (e: PolyglotException) {
            if (e.isCancelled || e.isInterrupted || e.isResourceExhausted) throw ScriptError(null, null, "실행 시간·자원 상한 초과(${props.script.timeoutMs}ms)", e)
            // sourceLocation 은 구문 오류가 아니면 비어있는 경우가 많다 — 첫 게스트(JS) 스택 프레임의 위치로 보완.
            val loc = e.sourceLocation ?: e.polyglotStackTrace.firstOrNull { it.isGuestFrame }?.sourceLocation
            val (line, col) = if (loc != null) loc.startLine to loc.startColumn
                else if (e.isSyntaxError) parseLineCol(e.message ?: "") else null to null
            throw ScriptError(line, col, cleanMessage(e), e)
        } catch (e: IllegalStateException) { // close(true) 직후 접근
            throw ScriptError(null, null, "실행 시간·자원 상한 초과(${props.script.timeoutMs}ms)", e)
        } finally {
            guard.cancel(false)
            runCatching { ctx.close(true) }
        }
    }

    private fun cleanMessage(e: PolyglotException): String {
        val m = e.message ?: e.toString()
        return if (e.isSyntaxError) "문법 오류: $m" else m.removePrefix("Error: ")
    }

    /** sourceLocation 이 없는 구문 오류용 폴백 — 메시지의 "plugin.js:line:col"(또는 ":line:col")을 파싱. */
    private fun parseLineCol(m: String): Pair<Int?, Int?> {
        val match = Regex("""plugin\.js:(\d+):(\d+)""").find(m) ?: Regex(""":(\d+):(\d+)""").find(m)
        return match?.let { it.groupValues[1].toIntOrNull() to it.groupValues[2].toIntOrNull() } ?: (null to null)
    }

    private fun evalPlugin(ctx: Context, source: Source): Value {
        val v = ctx.eval(source)
        if (v.isNull || !v.hasMembers() || v.canExecute() || v.hasArrayElements()) throw ScriptError(null, null, "스크립트의 마지막 값은 플러그인 객체({ id, label, … })여야 합니다")
        return v
    }

    private fun readMeta(p: Value): ScriptMeta {
        val id = p.str("id"); if (!ScriptMeta.ID.matches(id)) throw ScriptError(null, null, "id 는 소문자·숫자·하이픈 2~64자여야 합니다: '$id'")
        val kind = p.str("kind").ifBlank { ScriptMeta.TRANSFORM }
        if (kind !in ScriptMeta.KINDS) throw ScriptError(null, null, "kind 는 transform | fieldCodec | messageCodec 중 하나: '$kind'")
        val need = if (kind == ScriptMeta.TRANSFORM) listOf("apply") else listOf("encode", "decode")
        for (f in need) if (!p.getMember(f).let { it != null && it.canExecute() }) throw ScriptError(null, null, "$kind 플러그인에는 $f(…) 함수가 필요합니다")
        val inputs = ioList(p.getMember("inputs")).ifEmpty { listOf(FlowTransform.IoSpec.of("input", "입력")) }
        val outputs = ioList(p.getMember("outputs")).ifEmpty { listOf(FlowTransform.IoSpec.of("result", "결과")) }
        return ScriptMeta(id, p.str("label").ifBlank { id }, p.str("description"), kind, inputs, outputs, paramList(p.getMember("params")))
    }

    private fun ioList(v: Value?): List<FlowTransform.IoSpec> = arr(v).map { e ->
        val key = e.str("key"); if (key.isBlank()) throw ScriptError(null, null, "inputs/outputs 항목에 key 가 없습니다")
        FlowTransform.IoSpec(key, e.str("label").ifBlank { key }, e.str("type").ifBlank { "string" }, e.str("example"))
    }
    private fun paramList(v: Value?): List<FlowTransform.TransformParam> = arr(v).map { e ->
        val key = e.str("key"); if (key.isBlank()) throw ScriptError(null, null, "params 항목에 key 가 없습니다")
        FlowTransform.TransformParam(key, e.str("label").ifBlank { key }, e.str("type").ifBlank { "string" }, e.str("defaultValue"),
            arr(e.getMember("options")).map { FlHelpers.show(it) }, e.str("placeholder"))
    }
    private fun arr(v: Value?): List<Value> = if (v == null || v.isNull || !v.hasArrayElements()) emptyList() else (0 until v.arraySize).map { v.getArrayElement(it) }
    private fun Value.str(k: String): String = getMember(k)?.takeIf { !it.isNull }?.let { FlHelpers.show(it) } ?: ""

    private fun codecCtx(c: CodecCtx): ProxyObject = ProxyObject.fromMap(mapOf(
        "config" to ProxyObject.fromMap(c.config),
        "direction" to c.direction,
        "message" to ProxyObject.fromMap(c.message),
        "field" to (c.field?.let { ProxyObject.fromMap(mapOf("name" to it.name, "len" to it.len, "type" to it.type, "pad" to it.pad)) }),
    ))

    /** JS 객체 → Map<String,String>: 문자열은 그대로, 그 외는 JSON.stringify(엔진이 코어션은 SPI 쪽에서). */
    private fun toStringMap(ctx: Context, out: Value): Map<String, String> {
        if (out.isNull || !out.hasMembers()) throw ScriptError(null, null, "apply 는 { 출력키: 값 } 객체를 돌려줘야 합니다")
        val stringify = ctx.eval("js", "(v) => typeof v === 'string' ? v : (v === undefined ? '' : JSON.stringify(v))")
        val m = LinkedHashMap<String, String>()
        for (k in out.memberKeys) m[k] = stringify.execute(out.getMember(k)).asString()
        return m
    }
}
