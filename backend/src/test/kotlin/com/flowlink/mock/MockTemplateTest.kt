package com.flowlink.mock

import com.fasterxml.jackson.databind.ObjectMapper
import com.flowlink.mock.MockHttp.MockRequest
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

class MockTemplateTest {

    private val mapper = ObjectMapper()

    private fun ctx(
        body: String = """{"otp":"111111","user":{"name":"kim","addr":{"city":"Seoul"}},"items":[{"id":"A"},{"id":"B"}],"a.b":"flat"}""",
        secrets: Map<String, String> = mapOf("apiKey" to "SK-1"),
    ): MockContext {
        val req = MockRequest("POST", "/otp", mapOf("q" to "1"), mapOf("x-sig" to "sig1", "content-type" to "application/json"),
            body, MockHttp.parseBodyFields(body, "application/json", Charsets.UTF_8, mapper))
        return MockContext(req = req, pathParams = mapOf("id" to "42"), seq = 7L, state = mapOf("status" to "ok"), secrets = secrets, json = mapper)
    }

    @Test
    fun `두_문법_모두_해석`() {
        val c = ctx()
        assertThat(MockTemplate.render("{{body.otp}}|{{ otp@body }}|{{query.q}}|{{ q@query }}|{{path.id}}|{{ id@path }}", c)).isEqualTo("111111|111111|1|1|42|42")
        assertThat(MockTemplate.render("{{header.x-sig}}|{{ x-sig@header }}|{{state.status}}|{{ status@state }}", c)).isEqualTo("sig1|sig1|ok|ok")
        assertThat(MockTemplate.render("{{seq}}-{{method}}", c)).isEqualTo("7-POST")
        assertThat(MockTemplate.render("{{body}}", c)).startsWith("{\"otp\"")
    }

    @Test
    fun `시크릿_토큰_secret_소스`() {
        val c = ctx()
        assertThat(MockTemplate.render("Bearer {{ apiKey@secret }}", c)).isEqualTo("Bearer SK-1")
        assertThat(MockTemplate.render("{{ nope@secret }}|{{ x@env }}", c)).isEqualTo("|") // 없는 시크릿·미지원 소스(env)는 빈 문자열
    }

    @Test
    fun `본문_점_경로와_평평한_실키_우선`() {
        val c = ctx()
        assertThat(MockTemplate.render("{{ user.name@body }}/{{ user.addr.city@body }}/{{ items[1].id@body }}/{{body.items[0].id}}", c)).isEqualTo("kim/Seoul/B/A")
        assertThat(MockTemplate.render("{{ a.b@body }}", c)).isEqualTo("flat") // 실키 "a.b" 우선
        assertThat(MockTemplate.render("{{ user@body }}", c)).isEqualTo("""{"name":"kim","addr":{"city":"Seoul"}}""") // 객체는 JSON 문자열
        assertThat(MockTemplate.render("[{{ user.zzz@body }}]", c)).isEqualTo("[]")
    }

    @Test
    fun `미해석_토큰은_빈_문자열_그리고_텍스트_보존`() {
        val c = ctx()
        assertThat(MockTemplate.render("a {{ zzz }} b {{ foo@bar }} c", c)).isEqualTo("a  b  c")
        assertThat(MockTemplate.render("no tokens", c)).isEqualTo("no tokens")
        assertThat(MockTemplate.render(null, c)).isEqualTo("")
    }

    @Test
    fun `TCP_문맥_req_토큰`() {
        val bytes = "02001234567890홍길동".toByteArray(charset("EUC-KR"))
        val c = MockContext(seq = 3L, tcpReq = bytes, tcpCharset = charset("EUC-KR"), tcpFields = mapOf("계좌" to "1234567890"))
        assertThat(MockTemplate.render("{{ 계좌@req }}|{{req.계좌}}|{{req:0:4}}|{{seq}}", c)).isEqualTo("1234567890|1234567890|0200|3")
        assertThat(MockTemplate.render("{{req}}", c)).isEqualTo("02001234567890홍길동")
    }

    @Test
    fun `JsonPaths_setText`() {
        val root = mapper.readTree("""{"a":{"b":"1"},"arr":["x","y"]}""")
        assertThat(MockTemplate.JsonPaths.setText(root, "a.b", "ENC")).isTrue()
        assertThat(MockTemplate.JsonPaths.setText(root, "arr[1]", "Z")).isTrue()
        assertThat(MockTemplate.JsonPaths.setText(root, "a.none", "?")).isFalse()
        assertThat(root.toString()).isEqualTo("""{"a":{"b":"ENC"},"arr":["x","Z"]}""")
    }
}
