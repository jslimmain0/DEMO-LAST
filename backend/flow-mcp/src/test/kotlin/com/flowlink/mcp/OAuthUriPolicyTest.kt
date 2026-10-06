package com.flowlink.mcp

import org.junit.jupiter.api.Assertions.assertDoesNotThrow
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class OAuthUriPolicyTest {
    @Test fun `IDE callback URI만 허용한다`() {
        listOf("https://ide.example/callback", "http://127.0.0.1:4000/cb", "http://[::1]:4000/cb", "vscode://extension/callback").forEach {
            assertDoesNotThrow { McpOAuthService.validateRedirect(it) }
        }
        listOf("javascript:alert(1)", "file:///tmp/cb", "http://evil.example/cb", "https://user:pass@ide.example/cb", "https://ide.example/cb#token", "/relative").forEach {
            assertThrows(Exception::class.java) { McpOAuthService.validateRedirect(it) }
        }
    }
}
