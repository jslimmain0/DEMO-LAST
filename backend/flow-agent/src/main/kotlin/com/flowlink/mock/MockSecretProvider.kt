package com.flowlink.mock

import org.springframework.stereotype.Component
import java.util.concurrent.ConcurrentHashMap

/**
 * 환경 스코프 공급자 — `{{ 이름@secret }}`·`{{ 키@env }}` 를 풀기 위한 시크릿·환경 변수 맵을 **테넌트 + 환경 이름** 단위로 10초 캐시한다
 * (Transit/Vault·DB 왕복을 요청마다 안 하게). Mock 서빙(게이트웨이/TCP 리스너)·코덱 시험·프로토콜 미리보기·플러그인 시험 실행이 같이 쓴다.
 * 서빙 스레드에서 테넌트를 직접 지정해 호출한다. 조회 실패는 전파하며 빈 환경·시크릿으로 대체하지 않는다.
 */
@Component
class MockSecretProvider(private val loader: MockScopeLoader) {

    /** 한 환경의 시크릿(공통 + 오버레이) + 환경 변수. [resolver] 는 문자열의 두 토큰을 푸는 함수(다른 토큰은 빈 문자열 — MockTemplate 규약, 토큰 없으면 그대로). */
    class Scope(val secrets: Map<String, String>, val env: Map<String, String>) {
        private val masks by lazy { com.flowlink.execution.engine.SecretMasker.variants(secrets.values) }
        fun mask(value: String): String = com.flowlink.execution.engine.SecretMasker.mask(value, masks) ?: value

        /** 미리보기의 hex/base64도 원문과 같은 규칙으로 가린다. 길이는 보존한다. */
        fun maskBytes(bytes: ByteArray): ByteArray {
            if (secrets.isEmpty()) return bytes
            val out = bytes.copyOf()
            for (secret in secrets.values.filter { it.isNotBlank() }.sortedByDescending { it.length }) for (charset in listOf(Charsets.UTF_8, java.nio.charset.Charset.forName("EUC-KR"), java.nio.charset.Charset.forName("MS949"))) {
                val needle = secret.toByteArray(charset)
                if (needle.isEmpty() || needle.size > out.size) continue
                for (start in 0..out.size - needle.size) if (needle.indices.all { out[start + it] == needle[it] }) {
                    for (i in needle.indices) out[start + i] = '*'.code.toByte()
                }
            }
            return out
        }

        fun resolver(): (String) -> String {
            val ctx = MockContext(secrets = secrets, env = env)
            return { s -> if (s.contains("{{")) MockTemplate.render(s, ctx) else s }
        }
    }

    private class Entry(val scope: Scope, val at: Long)

    private val cache = ConcurrentHashMap<String, Entry>()

    /** [cached]=false 는 대화형(시험·미리보기) — 방금 저장한 값이 바로 보이게 캐시를 건너뛴다. */
    fun scope(tenantId: String, environment: String?, cached: Boolean = true, workspaceId: java.util.UUID? = null): Scope {
        val env = environment?.trim().orEmpty()
        val key = "$tenantId|$workspaceId|$env"
        val now = System.currentTimeMillis()
        if (cached) cache[key]?.let { if (now - it.at < TTL_MS) return it.scope }
        val loaded = load(tenantId, env, workspaceId)
        cache[key] = Entry(loaded, now)
        return loaded
    }

    fun secrets(tenantId: String, environment: String?): Map<String, String> = scope(tenantId, environment).secrets

    /** 시크릿/환경 변수 저장 후 즉시 반영이 필요할 때 — 전체 캐시 비움. */
    fun invalidate() = cache.clear()

    private fun load(tenantId: String, env: String, workspaceId: java.util.UUID?): Scope = loader.load(tenantId, env, workspaceId)

    companion object {
        const val TTL_MS = 10_000L
    }
}

fun interface MockScopeLoader { fun load(tenantId: String, environment: String, workspaceId: java.util.UUID?): MockSecretProvider.Scope }
