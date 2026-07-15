package com.flowlink.mock

/**
 * Mock 게이트웨이 URI 해석 — slug 팀(테넌트) 스코프 + 레거시 하위호환.
 *
 * `/mock/{a}/{b}/...` 에서
 * ① (tenant=a, slug=b) 쌍이 존재하면 그 mock (프리픽스 `/mock/a/b`)
 * ② 아니면 레거시: (tenant=default, slug=a) (프리픽스 `/mock/a`) — 기존 데이터·demos 무변경 동작.
 *
 * 더 구체적인 ①이 항상 우선한다. lookup 은 호출자(서비스)가 주입 — 순수 함수로 단위테스트 가능.
 */
object MockPathResolver {

    data class Resolved<T>(val server: T, val pathPrefix: String)

    fun <T : Any> resolve(
        requestUri: String,
        lookup: (tenant: String, slug: String) -> T?,
    ): Resolved<T>? {
        val prefix = "/mock/"
        if (!requestUri.startsWith(prefix)) return null
        val rest = requestUri.substring(prefix.length)
        if (rest.isEmpty()) return null
        val seg = rest.split('/')
        val first = seg[0]
        if (first.isEmpty()) return null
        val second = if (seg.size > 1) seg[1] else ""
        if (second.isNotEmpty()) {
            lookup(first, second)?.let { return Resolved(it, "/mock/$first/$second") }
        }
        lookup(DEFAULT_TENANT, first)?.let { return Resolved(it, "/mock/$first") }
        return null
    }

    private const val DEFAULT_TENANT = "default"
}
