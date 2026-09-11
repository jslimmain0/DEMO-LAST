package com.flowlink.secret

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import org.slf4j.LoggerFactory
import org.springframework.http.client.SimpleClientHttpRequestFactory
import org.springframework.stereotype.Component
import org.springframework.web.client.HttpClientErrorException
import org.springframework.web.client.RestClient
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicReference

/**
 * Vault KV v2 시크릿 소스 — `GET {address}/v1/{mount}/data/{path}` 를 X-Vault-Token 으로 읽어
 * `data.data` 의 키-값을 시크릿 맵으로 돌려준다. 실행마다 네트워크 호출을 피하려 TTL 캐시.
 *
 * 비활성(enabled=false)이거나 인증 미설정이면 빈 맵(네트워크 호출 없음). 조회 실패(다운/권한/네트워크)도 빈 맵이 아니라
 * **마지막 성공 캐시**를 유지 → 일시적 Vault 장애가 실행 시드/마스킹을 깨지 않는다(3초 타임아웃).
 *
 * ⚠ `flowlink.vault.enabled`(FLOWLINK_VAULT_ENABLED) 는 **이 KV 오버레이의 스위치**다 — Transit(KEK) 은
 * `flowlink.vault.transit.enabled` 만 보므로 Transit 만 쓰는 배포는 이 값을 끄면 된다. 켜 둔 채 토큰 정책에 KV read 가
 * 없으면 403 이 나는데, 그 실패는 **경로별로 첫 번만 WARN**(실제 요청 URL + 원인별 힌트)하고 같은 실패의 반복은 DEBUG,
 * 복구되면 INFO 로 남긴다(60초마다 WARN 이 반복되며 운영자를 오도하던 문제).
 */
@Component
class VaultSecretSource(
    private val props: VaultProperties,
    private val tokens: VaultTokenSource = VaultTokenSource.of(props),
    builder: RestClient.Builder = RestClient.builder().requestFactory(
        SimpleClientHttpRequestFactory().apply { setConnectTimeout(3000); setReadTimeout(3000) }
    ),
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val log = LoggerFactory.getLogger(VaultSecretSource::class.java)

    private val client: RestClient = builder.baseUrl(props.address).build()

    // 경로별 캐시. at=0 → 첫 호출은 now-0 이 TTL 보다 커 반드시 fetch (Long.MIN_VALUE 로 두면 뺄셈 오버플로로 "항상 신선" 오판).
    // failing=true 면 직전 갱신 시도가 실패한 상태(반복 실패는 DEBUG, 복구 시 INFO 판정용).
    private val caches = ConcurrentHashMap<String, AtomicReference<Cached>>()
    private data class Cached(val at: Long, val map: Map<String, String>, val failing: Boolean = false)

    val enabled: Boolean get() = props.enabled && tokens.available

    /** 캐시된 Vault 워크플로 시크릿(`{{ 이름@secret }}`). TTL 만료 시 1회 갱신 시도(실패 시 이전 캐시 유지). */
    fun secrets(): Map<String, String> = read(props.path)

    /**
     * 앱 설정 비밀(jwt-secret 등) — **별도 config 경로**에서 읽는다(워크플로 시크릿과 분리, 피커/해석에 미노출).
     * 없으면 null. env 로 이미 설정됐으면 호출자가 이 함수를 안 부르는 게 정상(env 우선).
     */
    fun appSecret(key: String): String? = read(props.configPath)[key]?.takeIf { it.isNotBlank() }

    /** 실제 요청 URL — 로그/힌트용(`주소 마운트/경로` 처럼 띄어 찍으면 URL 로 오인된다). */
    fun requestUrl(path: String): String = "${props.address}/v1/${props.mount}/data/$path"

    private fun read(path: String): Map<String, String> {
        if (!enabled) return emptyMap()
        val ref = caches.computeIfAbsent(path) { AtomicReference(Cached(0L, emptyMap())) }
        val now = clock()
        val cached = ref.get()
        if (now - cached.at < props.refreshSeconds * 1000L) return cached.map
        return try {
            val fresh = fetch(path)
            if (cached.failing) log.info("Vault KV 조회 복구(GET {}): {}건", requestUrl(path), fresh.size)
            ref.set(Cached(now, fresh))
            fresh
        } catch (e: Exception) {
            val reason = e.message?.lineSequence()?.firstOrNull()?.trim().orEmpty()
            if (cached.failing) {
                log.debug("Vault KV 조회 실패(반복, GET {}): {}", requestUrl(path), reason)
            } else {
                log.warn("Vault KV 조회 실패(GET {}): {} — 이전 캐시 유지({}건). {} 같은 실패가 계속되면 DEBUG 로만 남기고, 복구되면 INFO 로 알립니다.",
                    requestUrl(path), reason, cached.map.size, hint(e, path))
            }
            ref.set(Cached(now, cached.map, failing = true)) // 백오프: 실패도 TTL 갱신해 매 호출 재시도를 막음
            cached.map
        }
    }

    /** 원인별 조치 힌트 — 특히 "Transit 만 쓰는데 KV 403" 은 설정 착오라 그 사실을 바로 알려준다. */
    private fun hint(e: Exception, path: String): String = when {
        e is HttpClientErrorException.Forbidden && props.transit.enabled ->
            "403 = 이 토큰/AppRole 정책에 KV 경로 read 가 없습니다. FLOWLINK_VAULT_ENABLED 는 KV 시크릿 오버레이 전용이라 " +
                "Transit 만 쓰면 필요 없습니다 — 끄면(false) KV 호출이 사라집니다. KV 도 쓰려면 정책에 " +
                "path \"${props.mount}/data/$path\" { capabilities = [\"read\"] } 를 추가하세요."
        e is HttpClientErrorException.Forbidden ->
            "403 = 토큰/AppRole 정책에 path \"${props.mount}/data/$path\" { capabilities = [\"read\"] } 를 추가하세요."
        e is HttpClientErrorException.NotFound ->
            "404 = 그 경로에 시크릿이 없거나(vault kv put ${props.mount}/$path 키=값) KV v2 마운트 이름(FLOWLINK_VAULT_MOUNT=${props.mount})이 다릅니다."
        else -> "Vault 주소(FLOWLINK_VAULT_ADDRESS=${props.address})·네트워크·인증을 확인하세요."
    }

    private fun fetch(path: String): Map<String, String> {
        val resp = client.get()
            .uri("/v1/{mount}/data/{path}", props.mount, path)
            .header("X-Vault-Token", tokens.token())
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
