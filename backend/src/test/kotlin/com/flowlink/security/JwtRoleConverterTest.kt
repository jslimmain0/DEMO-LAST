package com.flowlink.security

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.springframework.security.oauth2.jwt.Jwt

/** Keycloak JWT 롤 클레임(realm_access/resource_access) → ROLE_* 권한 매핑 검증. */
class JwtRoleConverterTest {

    private val converter = JwtRoleConverter()

    private fun jwt(claims: Map<String, Any>): Jwt {
        val b = Jwt.withTokenValue("t").header("alg", "none").subject("sub-123")
        claims.forEach { (k, v) -> b.claim(k, v) }
        return b.build()
    }

    private fun authorities(claims: Map<String, Any>): Set<String> =
        converter.convert(jwt(claims))!!.authorities.map { it.authority }.toSet()

    @Test
    fun realmRoles() {
        val auth = authorities(mapOf("realm_access" to mapOf("roles" to listOf("editor", "viewer"))))
        assertEquals(setOf("ROLE_editor", "ROLE_viewer"), auth)
    }

    @Test
    fun resourceRoles() {
        val auth = authorities(
            mapOf("resource_access" to mapOf("flowlink-web" to mapOf("roles" to listOf("admin"))))
        )
        assertEquals(setOf("ROLE_admin"), auth)
    }

    @Test
    fun mergedAndDeduped() {
        val auth = authorities(
            mapOf(
                "realm_access" to mapOf("roles" to listOf("editor")),
                "resource_access" to mapOf(
                    "flowlink-web" to mapOf("roles" to listOf("editor", "platform-admin")),
                    "other-client" to mapOf("roles" to listOf("viewer"))
                )
            )
        )
        assertEquals(setOf("ROLE_editor", "ROLE_platform-admin", "ROLE_viewer"), auth)
    }

    @Test
    fun noRoleClaims() {
        assertTrue(authorities(mapOf("scope" to "openid")).isEmpty())
    }

    @Test
    fun namePrefersPreferredUsername() {
        val token = converter.convert(jwt(mapOf("preferred_username" to "alice")))!!
        assertEquals("alice", token.name)
    }

    @Test
    fun nameFallsBackToSubject() {
        val token = converter.convert(jwt(mapOf()))!!
        assertEquals("sub-123", token.name)
    }

    @Test
    fun malformedClaimShapesAreIgnored() {
        val auth = authorities(
            mapOf(
                "realm_access" to mapOf("roles" to "not-a-list"),
                "resource_access" to mapOf("c" to "not-a-map")
            )
        )
        assertTrue(auth.isEmpty())
    }
}
