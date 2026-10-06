package com.flowlink.desktop

import com.flowlink.common.lifecycle.RuntimeUpdateGate
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.springframework.mock.web.MockHttpServletRequest
import org.springframework.mock.web.MockHttpServletResponse

class DesktopUpdateFilterTest {
    @Test fun `HTTP admission blocks writes callbacks and mocks while update controls remain reachable`() {
        val gate = RuntimeUpdateGate().apply { freeze {} }
        val filter = DesktopUpdateFilter(gate)
        for ((method, path) in listOf("POST" to "/api/v1/flows/a/runs", "PUT" to "/api/v1/environments", "GET" to "/mock/demo/x", "GET" to "/relay/a/cb/b")) {
            val response = MockHttpServletResponse()
            filter.doFilter(MockHttpServletRequest(method, path), response) { _, _ -> fail("request must not be admitted") }
            assertEquals(503, response.status, path)
        }
        for ((method, path) in listOf("GET" to "/api/v1/desktop/update", "POST" to "/api/v1/desktop/update/open-window", "GET" to "/api/v1/flows")) {
            var admitted = false
            filter.doFilter(MockHttpServletRequest(method, path), MockHttpServletResponse()) { _, _ -> admitted = true }
            assertTrue(admitted, path)
        }
    }
}
