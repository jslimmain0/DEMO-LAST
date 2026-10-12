package com.flowlink.agent

import com.flowlink.common.error.BadRequestException
import com.flowlink.environment.EnvironmentService
import com.flowlink.secret.SecretService
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.test.context.TestPropertySource

@SpringBootTest
@TestPropertySource(properties = [
    "spring.datasource.url=jdbc:h2:mem:central-resource;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE",
    "spring.datasource.driver-class-name=org.h2.Driver", "spring.datasource.username=sa", "spring.datasource.password=",
    "spring.jpa.hibernate.ddl-auto=create-drop",
])
class CentralResourceControllerTest {
    @Autowired lateinit var controller: CentralResourceController
    @Autowired lateinit var environments: EnvironmentService
    @Autowired lateinit var secrets: SecretService

    @Test fun `PC 실행기에는 요청한 시크릿만 반환하고 환경은 서버 공통에서 읽는다`() {
        environments.put("central-dev", mapOf("base" to "https://central.example"), "public")
        secrets.put("selected", "selected-private-value", "central-dev", "public")
        secrets.put("unused", "unused-private-value", null, "public")
        val result = controller.resolve(CentralResourceController.Request("central-dev", true, setOf("selected")), "pc-device")
        assertThat(result.headers.cacheControl).isEqualTo("no-store")
        assertThat(result.body!!.vars).containsOnlyKeys("base")
        assertThat(result.body!!.secrets).containsExactly(java.util.Map.entry("selected", "selected-private-value"))
        assertThat(controller.resolve(CentralResourceController.Request("central-dev", true), "pc-device").body!!.secrets).isEmpty()
    }

    @Test fun `없는 서버 환경이나 시크릿은 빈 값으로 계속 실행하지 않는다`() {
        assertThrows<BadRequestException> { controller.resolve(CentralResourceController.Request("missing", true), "pc-device") }
        assertThrows<BadRequestException> { controller.resolve(CentralResourceController.Request(secretNames = setOf("missing")), "pc-device") }
        assertThrows<BadRequestException> { controller.resolve(CentralResourceController.Request(), null) }
    }
}
