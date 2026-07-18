package com.flowlink.secret

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import org.slf4j.LoggerFactory
import org.springframework.http.client.SimpleClientHttpRequestFactory
import org.springframework.stereotype.Component
import org.springframework.web.client.RestClient
import java.util.concurrent.atomic.AtomicReference

/**
 * Vault KV v2 시크릿 소스 — `GET {address}/v1/{mount}/data/{path}` 를 X-Vault-Token 으로 읽어
 * `data.data` 의 키-값을 시크릿 맵으로 돌려준다. 실행마다 네트워크 호출을 피하려 TTL 캐시.
 *
 * 비활성(enabled=false)이거나 토큰 미설정이면 빈 맵. 조회 실패(다운/네트워크)도 빈 맵이 아니라
 * **마지막 성공 캐시**를 유지 → 일시적 Vault 장애가 실행 시드/마스킹을 깨지 않는다(3초 타임아웃).
 */
@Component
class VaultSecretSource(private val props: VaultProperties) {
    private val log = LoggerFactory.getLogger(VaultSecretSource::class.java)

    private val client: RestClient = RestClient.builder()
        .baseUrl(props.address)
        .requestFactory(SimpleClientHttpRequestFactory().apply {
            setConnectTimeout(3000)
            setReadTimeout(3000)
        })
        .build()

    // at=0 → 첫 호출은 now-0 이 TTL 보다 커 반드시 fetch (Long.MIN_VALUE 로 두면 뺄셈이 오버플로해 "항상 신선"으로 오판).
    private val cache = AtomicReference(Cached(0L, emptyMap<String, String>()))
    private data class Cached(val at: Long, val map: Map<String, String>)

    val enabled: Boolean get() = props.enabled && props.token != null

    /** 캐시된 Vault 공통 시크릿. TTL 만료 시 1회 갱신 시도(실패 시 이전 캐시 유지). */
    fun secrets(): Map<String, String> {
        if (!enabled) return emptyMap()
        val now = System.currentTimeMillis()
        val cached = cache.get()
        if (now - cached.at < props.refreshSeconds * 1000L) return cached.map
        return try {
            val fresh = fetch()
            cache.set(Cached(now, fresh))
            fresh
        } catch (e: Exception) {
            log.warn("Vault 시크릿 조회 실패({} {}/{}): {} — 이전 캐시 유지({}건)",
                props.address, props.mount, props.path, e.message, cached.map.size)
            cache.set(Cached(now, cached.map)) // 백오프: 실패도 TTL 갱신해 매 실행 재시도를 막음
            cached.map
        }
    }

    private fun fetch(): Map<String, String> {
        val resp = client.get()
            .uri("/v1/{mount}/data/{path}", props.mount, props.path)
            .header("X-Vault-Token", props.token!!)
            .retrieve()
            .body(VaultKvV2Response::class.java)
        val data = resp?.data?.data ?: emptyMap()
        return data.entries.mapNotNull { (k, v) -> v?.let { k to it.toString() } }.toMap()
    }

    /** KV v2 응답 봉투: `{ data: { data: {k:v,...}, metadata: {...} } }` */
    @JsonIgnoreProperties(ignoreUnknown = true)
    data class VaultKvV2Response(val data: Inner?) {
        @JsonIgnoreProperties(ignoreUnknown = true)
        data class Inner(val data: Map<String, Any?>?)
    }
}
