package com.flowlink.plugin.script

import org.graalvm.polyglot.Value
import org.graalvm.polyglot.proxy.ProxyExecutable
import org.graalvm.polyglot.proxy.ProxyObject
import java.util.Base64

/**
 * 스크립트에 주입되는 `fl` 객체 — 전부 Graal 프록시(ProxyObject/ProxyExecutable)라 호스트 리플렉션 경로가 없다.
 * 문자열 인자는 Value 로 받아 직접 변환. logs 는 호출 단위 수집기(실행 패널용, 서빙 땐 버림).
 */
object FlHelpers {
    fun build(logs: MutableList<String>): ProxyObject = ProxyObject.fromMap(mapOf(
        "b64" to ProxyObject.fromMap(mapOf(
            "enc" to fn { a -> Base64.getEncoder().encodeToString(str(a, 0).toByteArray(Charsets.UTF_8)) },
            "dec" to fn { a -> String(Base64.getDecoder().decode(str(a, 0)), Charsets.UTF_8) },
        )),
        "log" to fn { a -> logs.add(a.joinToString(" ") { show(it) }); null },
    ))

    internal fun fn(body: (Array<Value>) -> Any?): ProxyExecutable = ProxyExecutable { args -> body(args) }
    internal fun str(a: Array<Value>, i: Int): String = a.getOrNull(i)?.takeIf { !it.isNull }?.let { show(it) } ?: ""
    internal fun show(v: Value): String = if (v.isString) v.asString() else v.toString()
}
