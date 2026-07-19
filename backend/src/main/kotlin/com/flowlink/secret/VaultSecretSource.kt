package com.flowlink.secret

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import org.slf4j.LoggerFactory
import org.springframework.http.client.SimpleClientHttpRequestFactory
import org.springframework.stereotype.Component
import org.springframework.web.client.RestClient
import java.util.concurrent.ConcurrentHashMap
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

    // 경로별 캐시. at=0 → 첫 호출은 now-0 이 TTL 보다 커 반드시 fetch (Long.MIN_VALUE 로 두면 뺄셈 오버플로로 "항상 신선" 오판).
    private val caches = ConcurrentHashMap<String, AtomicReference<Cached>>()
    private data class Cached(val at: Long, val map: Map<String, String>)

    val enabled: Boolean get() = props.enabled && props.token != null

    /** 캐시된 Vault 워크플로 시크릿(`{{ 이름@secret }}`). TTL 만료 시 1회 갱신 시도(실패 시 이전 캐시 유지). */
    fun secrets(): Map<String, String> = read(props.path)

    /**
     * 앱 설정 비밀(jwt-secret 등) — **별도 config 경로**에서 읽는다(워크플로 시크릿과 분리, 피커/해석에 미노출).
     * 없으면 null. env 로 이미 설정됐으면 호출자가 이 함수를 안 부르는 게 정상(env 우선).
     */
    fun appSecret(key: String): String? = read(props.configPath)[key]?.takeIf { it.isNotBlank() }

    private fun read(path: String): Map<String, String> {
        if (!enabled) return emptyMap()
        val ref = caches.computeIfAbsent(path) { AtomicReference(Cached(0L, emptyMap())) }
        val now = System.currentTimeMillis()
        val cached = ref.get()
        if (now - cached.at < props.refreshSeconds * 1000L) return cached.map
        return try {
            val fresh = fetch(path)
            ref.set(Cached(now, fresh))
            fresh
        } catch (e: Exception) {
            log.warn("Vault 조회 실패({} {}/{}): {} — 이전 캐시 유지({}건)",
                props.address, props.mount, path, e.message, cached.map.size)
            ref.set(Cached(now, cached.map)) // 백오프: 실패도 TTL 갱신해 매 호출 재시도를 막음
            cached.map
        }
    }

    private fun fetch(path: String): Map<String, String> {
        val resp = client.get()
            .uri("/v1/{mount}/data/{path}", props.mount, path)
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
