package com.flowlink.mock

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

/**
 * mock 게이트웨이 URI → (mock 서버, 경로 프리픽스) 해석 규칙 검증.
 * ① 두 세그먼트 (tenant, slug) 매치 우선 ② 실패 시 레거시 (default 테넌트, slug=첫 세그먼트) 폴백.
 */
class MockPathResolverTest {

    /** 존재하는 (tenant, slug) 쌍을 문자열 "tenant/slug" 집합으로 흉내낸다. */
    private fun lookup(vararg pairs: String): (String, String) -> String? = { t, s ->
        if (pairs.contains("$t/$s")) "$t/$s" else null
    }

    @Test
    fun tenantQualifiedMatchWins() {
        val r = MockPathResolver.resolve("/mock/team-a/demo/users/1", lookup("team-a/demo", "default/team-a"))
        assertEquals("team-a/demo", r!!.server)
        assertEquals("/mock/team-a/demo", r.pathPrefix)
    }

    @Test
    fun legacyFallbackToDefaultTenant() {
        val r = MockPathResolver.resolve("/mock/demo/users/1", lookup("default/demo"))
        assertEquals("default/demo", r!!.server)
        assertEquals("/mock/demo", r.pathPrefix)
    }

    @Test
    fun legacyWhenSecondSegmentIsNotASlug() {
        // /mock/demo/__routes — (demo, __routes) 쌍은 없으니 레거시 demo 로 폴백, 경로는 /__routes
        val r = MockPathResolver.resolve("/mock/demo/__routes", lookup("default/demo"))
        assertEquals("default/demo", r!!.server)
        assertEquals("/mock/demo", r.pathPrefix)
    }

    @Test
    fun singleSegment() {
        val r = MockPathResolver.resolve("/mock/demo", lookup("default/demo"))
        assertEquals("default/demo", r!!.server)
        assertEquals("/mock/demo", r.pathPrefix)
    }

    @Test
    fun singleSegmentWithTrailingSlash() {
        val r = MockPathResolver.resolve("/mock/demo/", lookup("default/demo"))
        assertEquals("default/demo", r!!.server)
        assertEquals("/mock/demo", r.pathPrefix)
    }

    @Test
    fun noMatchReturnsNull() {
        assertNull(MockPathResolver.resolve("/mock/nope/users", lookup("default/demo")))
    }

    @Test
    fun tenantPairPreferredOverLegacySlugOfSameName() {
        // team-a 라는 레거시 slug 와 (team-a, demo) 쌍이 공존하면 더 구체적인 쌍이 이긴다
        val r = MockPathResolver.resolve("/mock/team-a/demo", lookup("team-a/demo", "default/team-a"))
        assertEquals("team-a/demo", r!!.server)
    }

    @Test
    fun legacySlugServesPathWhenPairMisses() {
        // (team-a, users) 쌍이 없으면 레거시 slug team-a 의 /users 경로로
        val r = MockPathResolver.resolve("/mock/team-a/users", lookup("default/team-a"))
        assertEquals("default/team-a", r!!.server)
        assertEquals("/mock/team-a", r.pathPrefix)
    }

    @Test
    fun emptyAfterMockReturnsNull() {
        assertNull(MockPathResolver.resolve("/mock/", lookup("default/demo")))
        assertNull(MockPathResolver.resolve("/mock", lookup("default/demo")))
    }
}
