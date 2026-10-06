package com.flowlink.execution

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.springframework.mock.web.MockHttpServletRequest
import java.util.UUID

class RelayControllerBoundaryTest {
    @Test fun `query raw and consumed form retain callback body and ack`() {
        val bodies = mutableListOf<String>()
        val controller = RelayController(WaitCallbackReceiver { _, _, _, headers, body ->
            bodies.add(body)
            assertEquals("test", headers["x-source"])
            CallbackAck("text/plain; charset=UTF-8", "accepted")
        })
        val id = UUID.randomUUID()
        val get = MockHttpServletRequest("GET", "/").apply { queryString = "a=1"; addHeader("X-Source", "test") }
        val raw = MockHttpServletRequest("POST", "/").apply { setContent("raw한글".toByteArray(Charsets.UTF_8)); addHeader("X-Source", "test") }
        val form = MockHttpServletRequest("POST", "/").apply { addParameter("a", "한 글", "2"); addHeader("X-Source", "test") }
        for (request in listOf(get, raw, form)) {
            val response = controller.callback(id, "wait", request)
            assertEquals(200, response.statusCode.value())
            assertEquals("accepted", response.body)
            assertEquals("*", response.headers.getFirst("Access-Control-Allow-Origin"))
        }
        assertEquals(listOf("a=1", "raw한글", "a=%ED%95%9C+%EA%B8%80&a=2"), bodies)
    }
    @Test fun `oversize is guarded without dispatch and options skips receiver`() {
        var calls = 0
        val controller = RelayController(WaitCallbackReceiver { _, _, _, _, _ -> calls++; CallbackAck("text/plain", "") })
        val large = MockHttpServletRequest("POST", "/").apply { setContent(ByteArray(5 * 1024 * 1024 + 1)) }
        assertEquals(500, controller.callback(UUID.randomUUID(), "wait", large).statusCode.value())
        assertEquals(200, controller.callback(UUID.randomUUID(), "wait", MockHttpServletRequest("OPTIONS", "/")).statusCode.value())
        assertEquals(0, calls)
    }
}
