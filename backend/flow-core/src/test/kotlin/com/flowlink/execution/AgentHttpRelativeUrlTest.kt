package com.flowlink.execution
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.*
import org.springframework.mock.web.MockHttpServletRequest
class AgentHttpRelativeUrlTest {
    @Test fun `relative Mock belongs to this agent listener and preserves context`() {
        val request = MockHttpServletRequest().apply { localPort = 19234; serverPort = 18080; contextPath = "/flowlink" }
        assertEquals("http://localhost:19234/flowlink/mock/fixture/hello?x=1", resolveAgentRelativeUrl("/mock/fixture/hello?x=1", request))
        assertEquals("http://127.0.0.1:19234/flowlink/test", resolveAgentRelativeUrl("/test", request))
    }
    @Test fun `absolute URLs and network path are never rewritten`() {
        val request = MockHttpServletRequest().apply { localPort = 19234 }
        assertEquals("https://target.example/mock/a", resolveAgentRelativeUrl("https://target.example/mock/a", request))
        assertEquals("//other.example/mock/a", resolveAgentRelativeUrl("//other.example/mock/a", request))
    }
}
