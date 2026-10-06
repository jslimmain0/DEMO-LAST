package com.flowlink.security
import com.flowlink.common.host.LocalRuntimeSession
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.*
import org.mockito.Mockito.*
import org.springframework.beans.factory.support.StaticListableBeanFactory
import org.springframework.mock.web.MockHttpServletRequest
class AuthMetadataTest {
    @Test fun `server metadata keeps public context and standard TLS port`() {
        val beans = StaticListableBeanFactory()
        val controller = AuthController(mock(AuthProperties::class.java), "https://company.example/flowlink/", "", beans.getBeanProvider(LocalRuntimeSession::class.java), "서버")
        val cfg = controller.config(MockHttpServletRequest())
        assertEquals("https://company.example/flowlink/mcp", cfg.mcpUrl)
        assertEquals(443, cfg.mcpPort)
    }
    @Test fun `request fallback shares actual application port and context`() {
        val beans = StaticListableBeanFactory()
        val controller = AuthController(mock(AuthProperties::class.java), "", "", beans.getBeanProvider(LocalRuntimeSession::class.java), "서버")
        val req = MockHttpServletRequest().apply { serverPort = 18080; contextPath = "/flowlink" }
        assertEquals("http://localhost:18080/flowlink/mcp", controller.config(req).mcpUrl)
    }
    @Test fun `desktop has no central MCP endpoint even when public server configured`() {
        val beans = StaticListableBeanFactory(); beans.addBean("local", mock(LocalRuntimeSession::class.java))
        val controller = AuthController(mock(AuthProperties::class.java), "https://company.example", "https://company.example/mcp", beans.getBeanProvider(LocalRuntimeSession::class.java), "내 PC")
        val cfg = controller.config(MockHttpServletRequest())
        assertNull(cfg.mcpUrl); assertNull(cfg.mcpPort)
    }
}
