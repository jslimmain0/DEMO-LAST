package com.flowlink.common.error

import org.junit.jupiter.api.Test
import org.springframework.http.HttpMethod
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import org.springframework.test.web.servlet.setup.MockMvcBuilders
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.servlet.resource.NoResourceFoundException

class GlobalExceptionHandlerTest {
    @RestController
    class MissingRoute {
        @GetMapping("/api/v1/distribution")
        fun missing(): Nothing = throw NoResourceFoundException(HttpMethod.GET, "api/v1/distribution")
    }

    @Test fun `호스트에 없는 API의 리소스 404를 서버 오류로 바꾸지 않는다`() {
        MockMvcBuilders.standaloneSetup(MissingRoute()).setControllerAdvice(GlobalExceptionHandler()).build()
            .perform(get("/api/v1/distribution"))
            .andExpect(status().isNotFound)
            .andExpect(jsonPath("$.status").value(404))
            .andExpect(jsonPath("$.path").value("/api/v1/distribution"))
    }
}
