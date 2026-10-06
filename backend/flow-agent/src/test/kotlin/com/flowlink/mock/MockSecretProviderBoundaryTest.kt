package com.flowlink.mock

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.util.UUID

class MockSecretProviderBoundaryTest {
    @Test fun `cache isolates workspace and preview bypasses saved scope`() {
        val a = UUID.randomUUID(); val b = UUID.randomUUID()
        var calls = 0
        val provider = MockSecretProvider(MockScopeLoader { tenant, environment, workspace ->
            calls++
            MockSecretProvider.Scope(mapOf("secret" to "test-secret"), mapOf("scope" to "$tenant/$environment/$workspace/$calls"))
        })
        val first = provider.scope("tenant", "dev", workspaceId = a)
        assertSame(first, provider.scope("tenant", "dev", workspaceId = a))
        assertNotEquals(first.env, provider.scope("tenant", "dev", workspaceId = b).env)
        assertNotSame(first, provider.scope("tenant", "dev", cached = false, workspaceId = a))
        assertEquals(3, calls)
        provider.invalidate()
        provider.scope("tenant", "dev", workspaceId = a)
        assertEquals(4, calls)
        assertFalse(first.mask("test-secret").contains("test-secret"))
    }
}
