package com.flowlink.security

import com.flowlink.settings.SettingsService
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
import java.security.SecureRandom
import java.time.Instant
import java.util.Base64
import java.util.Date
import javax.crypto.spec.SecretKeySpec

/**
 * 앱 자체 JWT 발급/검증(HS256). GitHub 로그인 성공 시 이 토큰을 발급하고, 리소스 서버가 이 토큰을 검증한다.
 * 클레임 구조(preferred_username·tenant·realm_access.roles — Keycloak 호환 형식)는
 * [JwtRoleConverter]·[TenantClaimFilter] 가 읽는다.
 * 서명 시크릿은 env → 설정 테이블(auth.jwt-secret) → 자동 생성·저장 순.
 */
@Component
class AppJwt(props: AuthProperties, settings: SettingsService) {
    private val log = LoggerFactory.getLogger(AppJwt::class.java)

    // 서명 시크릿 — env FLOWLINK_AUTH_JWT_SECRET 우선, 없으면 설정 테이블(auth.jwt-secret), 그것도 없으면 자동 생성해 저장(재시작에도 유지).
    // HS256 은 256bit 키 필요 — 시크릿을 SHA-256 으로 32B 파생(StateCrypto 와 동일 방식)
    private val keyBytes: ByteArray = MessageDigest.getInstance("SHA-256").digest(
        (props.jwtSecret ?: settings.get(KEY_JWT_SECRET)
            ?: Base64.getEncoder().encodeToString(ByteArray(32).also { SecureRandom().nextBytes(it) }).also {
                settings.put(KEY_JWT_SECRET, it)
                log.info("jwt-secret 미설정 — 자동 생성해 설정 테이블(auth.jwt-secret)에 저장")
            }).toByteArray(Charsets.UTF_8),
    )
    private val ttl = props.tokenTtlHours

    /** GitHub 로그인 사용자에게 앱 JWT 발급 — 전역 공유 워크플로 도구라 tenant=default·전권 롤. */
    fun issue(login: String, tenant: String = "default", roles: List<String> = FULL_ROLES): String {
        val now = Instant.now()
        val claims = JWTClaimsSet.Builder()
            .subject(login)
            .claim("preferred_username", login)
            .claim(CLAIM_TENANT, tenant)
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
        const val KEY_JWT_SECRET = "auth.jwt-secret"
        /** 발급 JWT 의 테넌트 클레임 이름 — TenantClaimFilter 가 같은 이름으로 읽는다. */
        const val CLAIM_TENANT = "tenant"
        val FULL_ROLES = listOf("admin", "editor", "platform-admin") // 자기 도구 — GitHub 인증 사용자에게 전권
    }
}
