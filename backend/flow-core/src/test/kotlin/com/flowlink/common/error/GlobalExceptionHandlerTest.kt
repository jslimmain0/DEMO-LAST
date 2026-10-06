package com.flowlink.common.error

import org.junit.jupiter.api.Test
import org.springframework.http.HttpMethod
import org.springframework.http.HttpStatus
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import org.springframework.test.web.servlet.setup.MockMvcBuilders
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.server.ResponseStatusException
import org.springframework.web.servlet.resource.NoResourceFoundException

class GlobalExceptionHandlerTest {
    @RestController
    class MissingRoute {
        @GetMapping("/api/v1/distribution")
        fun missing(): Nothing = throw NoResourceFoundException(HttpMethod.GET, "api/v1/distribution")
        @GetMapping("/status/{code}")
        fun rejected(@PathVariable code: Int): Nothing = throw ResponseStatusException(HttpStatus.valueOf(code), "요청을 처리할 수 없습니다")
    }

    @Test fun `호스트에 없는 API의 리소스 404를 서버 오류로 바꾸지 않는다`() {
        MockMvcBuilders.standaloneSetup(MissingRoute()).setControllerAdvice(GlobalExceptionHandler()).build()
            .perform(get("/api/v1/distribution"))
            .andExpect(status().isNotFound)
            .andExpect(jsonPath("$.status").value(404))
            .andExpect(jsonPath("$.path").value("/api/v1/distribution"))
    }

    @Test fun `명시한 요청 오류 상태를 500으로 바꾸지 않는다`() {
        val mvc = MockMvcBuilders.standaloneSetup(MissingRoute()).setControllerAdvice(GlobalExceptionHandler()).build()
        for (code in listOf(400, 401, 403, 404, 409, 429)) {
            mvc.perform(get("/status/$code")).andExpect(status().`is`(code))
                .andExpect(jsonPath("$.status").value(code))
                .andExpect(jsonPath("$.message").value("요청을 처리할 수 없습니다"))
        }
    }
}
