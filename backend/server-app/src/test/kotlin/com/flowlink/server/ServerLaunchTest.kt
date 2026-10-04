package com.flowlink.server

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.springframework.mock.env.MockEnvironment

class ServerLaunchTest {
    @Test fun `서버 시작점은 해석된 desktop 프로파일을 DB 연결 전에 거부한다`() {
        validateServerProfiles(MockEnvironment().apply { setActiveProfiles("local") })
        validateServerProfiles(MockEnvironment().apply { setActiveProfiles("dev") })
        assertThrows<IllegalArgumentException> {
            validateServerProfiles(MockEnvironment().apply { setActiveProfiles("local", "desktop") })
        }
        assertThrows<IllegalArgumentException> {
            validateServerProfiles(MockEnvironment().apply { setDefaultProfiles("desktop") })
        }
    }
}
