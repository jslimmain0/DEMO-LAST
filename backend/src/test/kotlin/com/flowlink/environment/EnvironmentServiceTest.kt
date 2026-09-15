package com.flowlink.environment

import com.flowlink.common.error.BadRequestException
import com.flowlink.common.error.ForbiddenException
import com.flowlink.core.repository.AppUserRepository
import com.flowlink.definition.FlowService
import com.flowlink.definition.dto.CreateFlowRequest
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.security.oauth2.jwt.Jwt
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken
import org.springframework.test.context.TestPropertySource

@SpringBootTest
@TestPropertySource(properties = [
    "spring.datasource.url=jdbc:h2:mem:envsvc;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE",
    "spring.datasource.driver-class-name=org.h2.Driver",
    "spring.datasource.username=sa",
    "spring.datasource.password=",
    "spring.jpa.hibernate.ddl-auto=create-drop",
])
class EnvironmentServiceTest {

    @Autowired lateinit var service: EnvironmentService
    @Autowired lateinit var flowService: FlowService
    @Autowired lateinit var userRepo: AppUserRepository

    @AfterEach
    fun clear() = SecurityContextHolder.clearContext()

    private fun asUser(name: String) {
        val jwt = Jwt.withTokenValue("t").header("alg", "none").claim("preferred_username", name).subject(name).build()
        SecurityContextHolder.getContext().authentication = JwtAuthenticationToken(jwt)
    }

    private fun approve(name: String) {
        val t = com.flowlink.common.tenant.TenantContext.SHARED_FLOW_TENANT
        val u = userRepo.findByTenantIdAndUsername(t, name).orElseGet { userRepo.save(com.flowlink.core.domain.AppUser.of(t, name)) }
        u.status = com.flowlink.core.domain.AppUser.STATUS_APPROVED
        userRepo.save(u)
    }

    @Test
    fun `dev 모드 - 생성 갱신 목록 이름변경 삭제`() {
        service.put("dev", mapOf("baseUrl" to "http://a", " " to "무시", "token" to "t1"))
        service.put("prod", mapOf("baseUrl" to "http://p"))
        var list = service.list()
        assertThat(list.map { it.name }).containsExactly("dev", "prod")
        assertThat(list[0].vars).containsExactly(java.util.Map.entry("baseUrl", "http://a"), java.util.Map.entry("token", "t1"))

        service.put("dev", mapOf("baseUrl" to "http://b")) // 통째 교체
        assertThat(service.list().first { it.name == "dev" }.vars).containsOnlyKeys("baseUrl")

        val renamed = service.rename("dev", "staging")
        assertThat(renamed.name).isEqualTo("staging")
        assertThat(renamed.vars["baseUrl"]).isEqualTo("http://b")
        assertThat(service.list().map { it.name }).containsExactly("prod", "staging")
        assertThatThrownBy { service.rename("staging", "prod") }.isInstanceOf(BadRequestException::class.java)
        assertThatThrownBy { service.put("  ", emptyMap()) }.isInstanceOf(BadRequestException::class.java)

        service.delete("prod")
        service.delete("없는것") // 멱등
        list = service.list()
        assertThat(list.map { it.name }).containsExactly("staging")
    }

    @Test
    fun `승인 안 된 사용자는 쓰기 403 - 읽기는 가능`() {
        asUser("guest-x")
        assertThatThrownBy { service.put("dev", mapOf("a" to "1")) }.isInstanceOf(ForbiddenException::class.java)
        assertThat(service.list()).isNotNull
        approve("guest-x")
        service.put("dev2", mapOf("a" to "1"))
        assertThat(service.list().map { it.name }).contains("dev2")
    }

    @Test
    fun `실행 입력값 - 플로우별 저장, 빈 값은 삭제`() {
        val flow = flowService.create(CreateFlowRequest("env-input", null, null, null))
        assertThat(service.runInput(flow.id)).isEmpty()
        service.putRunInput(flow.id, mapOf("orderId" to "A-1", "" to "skip"))
        assertThat(service.runInput(flow.id)).containsExactly(java.util.Map.entry("orderId", "A-1"))
        service.putRunInput(flow.id, emptyMap())
        assertThat(service.runInput(flow.id)).isEmpty()
        assertThatThrownBy { service.runInput(java.util.UUID.randomUUID()) }.isInstanceOf(BadRequestException::class.java)
    }
}
