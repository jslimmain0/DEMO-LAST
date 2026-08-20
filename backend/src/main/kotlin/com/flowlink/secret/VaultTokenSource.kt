package com.flowlink.secret

import com.fasterxml.jackson.annotation.JsonIgnoreProperties
import com.fasterxml.jackson.annotation.JsonProperty
import org.slf4j.LoggerFactory
import org.springframework.http.client.SimpleClientHttpRequestFactory
import org.springframework.web.client.RestClient

/**
 * Vault 인증 토큰 소스 — KV 조회·Transit 암복호가 매 요청에 실을 `X-Vault-Token` 을 공급한다.
 * AppRole(role_id/secret_id)이 설정되면 로그인·자동 갱신([AppRoleTokenSource]), 아니면 기존 static 토큰.
 */
interface VaultTokenSource {
    /** 현재 유효 토큰 — AppRole 이면 필요 시 로그인/갱신을 수행한다. 미구성/실패는 예외. */
    fun token(): String

    /** 어떤 인증이라도 구성돼 있는지(static 토큰 또는 AppRole). */
    val available: Boolean

    companion object {
        /** 선택 규칙: AppRole 구성 시 AppRole(정석 — static 보다 우선), 아니면 static 토큰. */
        @JvmStatic
        fun of(props: VaultProperties): VaultTokenSource =
            if (props.approle.configured) AppRoleTokenSource(props) else StaticTokenSource(props.token)
    }
}

/** 고정 토큰(env) — 기존 동작 그대로(무회귀). */
class StaticTokenSource(private val value: String?) : VaultTokenSource {
    override val available: Boolean = value != null
    override fun token(): String = value ?: throw IllegalStateException("Vault 토큰 미설정")
}

/**
 * AppRole 로그인 + 게으른 자동 갱신 — 최초 접근 시 `auth/{mount}/login`, 수명 절반이 지나면
 * `auth/token/renew-self`, 갱신 실패/만료면 재로그인(앱 재시작 불필요). 스레드 안전(synchronized).
 */
class AppRoleTokenSource(
    private val props: VaultProperties,
    builder: RestClient.Builder = RestClient.builder().requestFactory(
        SimpleClientHttpRequestFactory().apply { setConnectTimeout(3000); setReadTimeout(3000) }
    ),
    private val clock: () -> Long = System::currentTimeMillis,
) : VaultTokenSource {

    private val client: RestClient = builder.baseUrl(props.address).build()

    private var current: String? = null
    private var issuedAtMs: Long = 0
    private var leaseMs: Long = 0

    override val available: Boolean = true

    @Synchronized
    override fun token(): String {
        val now = clock()
        val tok = current
        if (tok == null || now >= issuedAtMs + leaseMs) {
            return login(now) // 최초 또는 만료 — renew 불가, 곧장 로그인
        }
        if (now >= issuedAtMs + leaseMs / 2) {
            return try {
                renew(tok, now)
            } catch (e: Exception) {
                log.warn("Vault 토큰 renew 실패({}) — 재로그인", e.message)
                login(now)
            }
        }
        return tok
    }

    private fun login(now: Long): String {
        val auth = client.post()
            .uri("/v1/auth/{mount}/login", props.approle.mount)
            .body(mapOf("role_id" to props.approle.roleId, "secret_id" to props.approle.secretId))
            .retrieve()
            .body(AuthResponse::class.java)?.auth
            ?: throw IllegalStateException("Vault AppRole 로그인 응답에 auth 없음")
        apply(auth, now)
        log.info("Vault AppRole 로그인 — lease {}s", auth.leaseDuration)
        return auth.clientToken
    }

    private fun renew(tok: String, now: Long): String {
        val auth = client.post()
            .uri("/v1/auth/token/renew-self")
            .header("X-Vault-Token", tok)
            .body(emptyMap<String, Any>())
            .retrieve()
            .body(AuthResponse::class.java)?.auth
            ?: throw IllegalStateException("Vault renew-self 응답에 auth 없음")
        apply(auth, now)
        log.info("Vault 토큰 갱신 — lease {}s", auth.leaseDuration)
        return auth.clientToken
    }

    private fun apply(auth: AuthResponse.Auth, now: Long) {
        current = auth.clientToken
        issuedAtMs = now
        leaseMs = auth.leaseDuration * 1000
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    data class AuthResponse(val auth: Auth?) {
        @JsonIgnoreProperties(ignoreUnknown = true)
        data class Auth(
            @JsonProperty("client_token") val clientToken: String,
            @JsonProperty("lease_duration") val leaseDuration: Long = 0,
        )
    }

    companion object {
        private val log = LoggerFactory.getLogger(AppRoleTokenSource::class.java)
    }
}
