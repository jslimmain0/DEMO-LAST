package com.flowlink.security

import org.springframework.core.convert.converter.Converter
import org.springframework.security.authentication.AbstractAuthenticationToken
import org.springframework.security.core.authority.SimpleGrantedAuthority
import org.springframework.security.oauth2.jwt.Jwt
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken

/**
 * Keycloak JWT 의 롤 클레임을 Spring Security 권한으로 매핑.
 *
 * - `realm_access.roles` + `resource_access.{client}.roles` 전부 → `ROLE_{롤명}`
 *   (기본 [org.springframework.security.oauth2.server.resource.authentication.JwtGrantedAuthoritiesConverter]는
 *   scope 클레임만 보므로 Keycloak 롤은 커스텀 매핑이 필요하다)
 * - principal name 은 `preferred_username`(없으면 sub) — 실행 이력 triggeredBy 에 사용.
 *
 * 클레임 형태가 예상과 다르면(리스트가 아님 등) 조용히 무시한다 — IdP 비종속 원칙상
 * 롤 클레임이 없는 토큰도 인증 자체는 유효(권한만 빈 목록).
 */
class JwtRoleConverter : Converter<Jwt, AbstractAuthenticationToken> {

    override fun convert(jwt: Jwt): AbstractAuthenticationToken {
        val roles = LinkedHashSet<String>()
        collectRoles(jwt.getClaimAsMap("realm_access"), roles)
        val resourceAccess = runCatching { jwt.getClaimAsMap("resource_access") }.getOrNull()
        resourceAccess?.values?.forEach { client -> collectRoles(client as? Map<*, *>, roles) }

        val authorities = roles.map { SimpleGrantedAuthority("ROLE_$it") }
        val name = jwt.getClaimAsString("preferred_username") ?: jwt.subject
        return JwtAuthenticationToken(jwt, authorities, name)
    }

    private fun collectRoles(claim: Map<*, *>?, into: MutableSet<String>) {
        val roles = claim?.get("roles") as? Collection<*> ?: return
        roles.forEach { r -> r?.let { into.add(it.toString()) } }
    }
}
