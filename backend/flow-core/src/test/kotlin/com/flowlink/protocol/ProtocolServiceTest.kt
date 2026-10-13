package com.flowlink.protocol

import com.flowlink.common.error.BadRequestException
import com.flowlink.common.error.ForbiddenException
import com.flowlink.common.json.JsonService
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
    "spring.datasource.url=jdbc:h2:mem:protosvc;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE",
    "spring.datasource.driver-class-name=org.h2.Driver", "spring.datasource.username=sa", "spring.datasource.password=",
    "spring.jpa.hibernate.ddl-auto=create-drop",
])
class ProtocolServiceTest {
    @Autowired lateinit var service: ProtocolService
    @Autowired lateinit var json: JsonService

    @AfterEach fun clear() = SecurityContextHolder.clearContext()

    private val specJson = """{"encoding":"EUC-KR","lengthField":"전문길이","discriminator":"거래코드",
        "header":[{"name":"전문길이","len":4,"type":"length"},{"name":"거래코드","len":4,"type":"ascii"}],
        "messages":[{"key":"0210","label":"요청","fields":[{"name":"계좌번호","len":13,"type":"ascii"}]}]}"""

    @Test
    fun `CRUD + 이름 중복 400 + 검증 400`() {
        val d = service.create("원장계", json.readTree(specJson))
        assertThat(service.list().map { it.name }).contains("원장계")
        assertThat(service.get(d.id).spec.path("lengthField").asText()).isEqualTo("전문길이")
        assertThatThrownBy { service.create("원장계", json.readTree(specJson)) }.isInstanceOf(BadRequestException::class.java).hasMessageContaining("이미")
        assertThatThrownBy { service.create("깨진", json.readTree("""{"lengthField":"x","header":[]}""")) }.isInstanceOf(BadRequestException::class.java).hasMessageContaining("x")
        val u = service.update(d.id, "원장계2", null)
        assertThat(u.name).isEqualTo("원장계2")
        assertThat(service.specOf(d.id).message("0210")).isNotNull()
        service.delete(d.id)
        assertThatThrownBy { service.get(d.id) }.isInstanceOf(com.flowlink.common.error.NotFoundException::class.java)
    }

    @Test
    fun `미리보기 - 검증 실패는 errors 로, 정상은 hex`() {
        val ok = service.preview(ProtocolDtos.PreviewRequest(json.readTree(specJson), "0210", mapOf("계좌번호" to "1122334567890"), null))
        assertThat(ok.errors).isEmpty()
        assertThat(ok.total).isEqualTo(21)
        assertThat(ok.text).startsWith("00170210")
        val bad = service.preview(ProtocolDtos.PreviewRequest(json.readTree(specJson), "0210", mapOf("계좌번호" to "한글"), null))
        assertThat(bad.errors).hasSize(1)
        assertThat(bad.errors[0].field).isEqualTo("계좌번호")
    }

    @Test
    fun `승인 안 된 사용자는 쓰기 403`() {
        val jwt = Jwt.withTokenValue("t").header("alg", "none").claim("preferred_username", "guest-p").subject("guest-p").build()
        SecurityContextHolder.getContext().authentication = JwtAuthenticationToken(jwt)
        assertThatThrownBy { service.create("x", json.readTree(specJson)) }.isInstanceOf(ForbiddenException::class.java)
        assertThat(service.list()).isNotNull
    }

    @Test fun `미리보기 응답 경계는 기존 코덱 방향을 바꾸지 않고 선택한다`() {
        val spec = json.readTree("""{"encoding":"UTF-8","framing":{"mode":"fixed","fixedLength":14},
            "responseFraming":{"mode":"fixed","fixedLength":8},"discriminator":"code",
            "header":[{"name":"code","len":4,"type":"ascii"}],
            "messages":[{"key":"REQ1","fields":[{"name":"value","len":10,"type":"ascii"}]},
                        {"key":"RES1","fields":[{"name":"value","len":4,"type":"ascii"}]}]}""")
        val request = ProtocolDtos.PreviewRequest(spec, "REQ1", mapOf("value" to "ABCDEFGHIJ"))
        assertThat(service.preview(request).total).isEqualTo(14)
        val response = request.copy(key = "RES1", values = mapOf("value" to "A001"))
        assertThat(service.preview(response).errors).hasSize(1)
        val result = service.preview(response.copy(frameDirection = "recv"))
        assertThat(result.errors).isEmpty()
        assertThat(result.text).isEqualTo("RES1A001")
        assertThat(result.total).isEqualTo(8)
        assertThat(service.preview(response.copy(direction = "recv")).total).isEqualTo(8)
        assertThatThrownBy { service.preview(response.copy(frameDirection = "other")) }
            .isInstanceOf(BadRequestException::class.java)
    }
}
