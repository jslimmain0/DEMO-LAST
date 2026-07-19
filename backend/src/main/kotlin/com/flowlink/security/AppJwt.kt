package com.flowlink.security

import com.nimbusds.jose.JWSAlgorithm
import com.nimbusds.jose.JWSHeader
import com.nimbusds.jose.crypto.MACSigner
import com.nimbusds.jwt.JWTClaimsSet
import com.nimbusds.jwt.SignedJWT
import org.slf4j.LoggerFactory
import org.springframework.security.oauth2.jose.jws.MacAlgorithm
import org.springframework.security.oauth2.jwt.JwtDecoder
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder
import org.springframework.stereotype.Component
import java.security.MessageDigest
import java.time.Instant
import java.util.Date
import javax.crypto.spec.SecretKeySpec

/**
 * 앱 자체 JWT 발급/검증(HS256). GitHub 로그인 성공 시 이 토큰을 발급하고, 리소스 서버가 이 토큰을 검증한다.
 * 클레임 구조를 Keycloak JWT 와 동일하게(preferred_username·tenant·realm_access.roles) 맞춰 기존
 * [JwtRoleConverter]·[TenantClaimFilter] 를 그대로 재사용한다.
 */
@Component
class AppJwt(props: AuthProperties, vault: com.flowlink.secret.VaultSecretSource) {
    private val log = LoggerFactory.getLogger(AppJwt::class.java)

    // 서명 시크릿 해석 — env(FLOWLINK_AUTH_JWT_SECRET, 로컬) 우선, 없으면 Vault config 경로(flowlink-config/jwt-secret, 운영).
    // env 가 있으면 Vault 를 아예 조회하지 않는다(?: 단락). 둘 다 없으면 null.
    private val resolvedSecret: String? = props.jwtSecret
        ?: try { vault.appSecret(VAULT_JWT_KEY) } catch (e: Exception) { log.warn("Vault jwt-secret 조회 실패: {}", e.message); null }

    /** env 또는 Vault 로 서명 시크릿이 실제로 설정됐는지 — [GithubAuthStartupValidator] 가 github 모드 기동 가드에 사용. */
    val hasSecret: Boolean get() = resolvedSecret != null

    // HS256 은 256bit 키 필요 — 설정 시크릿을 SHA-256 으로 32B 파생(StateCrypto 와 동일 방식)
    private val keyBytes: ByteArray = MessageDigest.getInstance("SHA-256")
        .digest((resolvedSecret ?: run {
            log.warn("jwt-secret 미설정(env·Vault 모두) — dev 폴백 키 사용. github 모드는 기동 가드가 막음(dev 모드 전용 폴백).")
            "flowlink-dev-app-jwt-secret"
        }).toByteArray(Charsets.UTF_8))
    private val ttl = props.tokenTtlHours

    /** GitHub 로그인 사용자에게 앱 JWT 발급 — 전역 공유 워크플로 도구라 tenant=default·전권 롤. */
    fun issue(login: String, tenant: String = "default", roles: List<String> = FULL_ROLES): String {
        val now = Instant.now()
        val claims = JWTClaimsSet.Builder()
            .subject(login)
            .claim("preferred_username", login)
            .claim("tenant", tenant)
            .claim("realm_access", mapOf("roles" to roles))
            .issuer("flowlink")
            .issueTime(Date.from(now))
            .expirationTime(Date.from(now.plusSeconds(ttl * 3600L)))
            .build()
        val jws = SignedJWT(JWSHeader(JWSAlgorithm.HS256), claims)
        jws.sign(MACSigner(keyBytes))
        return jws.serialize()
    }

    /** 리소스 서버가 쓸 디코더(HS256, 같은 키). */
    fun decoder(): JwtDecoder = NimbusJwtDecoder
        .withSecretKey(SecretKeySpec(keyBytes, "HmacSHA256"))
        .macAlgorithm(MacAlgorithm.HS256)
        .build()

    companion object {
        val FULL_ROLES = listOf("admin", "editor", "platform-admin") // 자기 도구 — GitHub 인증 사용자에게 전권
        const val VAULT_JWT_KEY = "jwt-secret" // Vault config 경로(flowlink-config)의 서명 시크릿 키
    }
}
