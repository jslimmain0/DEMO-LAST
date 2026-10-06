package com.flowlink.server.bridge
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.*
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.security.oauth2.jwt.Jwt
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken
import org.springframework.web.server.ResponseStatusException
class DesktopBridgeControllerTest {
    @Test fun `invalid bridge input is REST 400 without changing global IllegalArgument policy`() {
        val controller = DesktopBridgeController(DesktopBridgeService())
        val mvc = org.springframework.test.web.servlet.setup.MockMvcBuilders.standaloneSetup(controller)
            .setControllerAdvice(com.flowlink.common.error.GlobalExceptionHandler()).build()
        try {
            val jwt = Jwt.withTokenValue("test-only").header("alg", "none").subject("user").claim("tenant", "company").build()
            SecurityContextHolder.getContext().authentication = JwtAuthenticationToken(jwt)
            mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post("/api/v1/desktop-bridge/connect")
                .contentType(org.springframework.http.MediaType.APPLICATION_JSON).content("{\"deviceId\":\"\"}"))
                .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.status().isBadRequest)
            mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post("/api/v1/desktop-bridge/requests")
                .contentType(org.springframework.http.MediaType.APPLICATION_JSON).content("{\"requestId\":\"${java.util.UUID.randomUUID()}\",\"method\":\"GET\",\"path\":\"/api/v1/desktop/shutdown\"}"))
                .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.status().isBadRequest)
        } finally { SecurityContextHolder.clearContext() }
    }
    @Test fun `bridge requires caller JWT and only reports same account device`() {
        val service = DesktopBridgeService()
        val controller = DesktopBridgeController(service)
        try {
            SecurityContextHolder.clearContext()
            assertEquals(401, assertThrows(ResponseStatusException::class.java) { controller.status() }.statusCode.value())
            val jwt = Jwt.withTokenValue("test-only").header("alg", "none").subject("user").claim("tenant", "company").build()
            SecurityContextHolder.getContext().authentication = JwtAuthenticationToken(jwt)
            service.connect("company|user", "pc")
            assertEquals(true, controller.status()["online"])
            assertEquals("pc", controller.status()["deviceId"])
            val other = Jwt.withTokenValue("test-only").header("alg", "none").subject("other").claim("tenant", "company").build()
            SecurityContextHolder.getContext().authentication = JwtAuthenticationToken(other)
            assertEquals(false, controller.status()["online"])
            assertNull(controller.status()["deviceId"])
        } finally { SecurityContextHolder.clearContext() }
    }
}
