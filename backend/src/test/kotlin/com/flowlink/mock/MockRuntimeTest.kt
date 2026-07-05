package com.flowlink.mock

import com.flowlink.mock.MockHttp.MockRequest
import com.flowlink.mock.MockSpec.KV
import com.flowlink.mock.MockSpec.MockCallback
import com.flowlink.mock.MockSpec.MockCond
import com.flowlink.mock.MockSpec.MockRoute
import com.flowlink.mock.MockSpec.MockRule
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import java.nio.charset.Charset

class MockRuntimeTest {

    private val runtime = MockRuntime()

    private fun req(
        method: String,
        path: String,
        query: Map<String, String> = emptyMap(),
        headers: Map<String, String> = emptyMap(),
        bodyText: String = "",
        bodyFields: Map<String, String> = emptyMap()
    ): MockRequest = MockRequest(method, path, query, headers, bodyText, bodyFields)

    private fun rule(id: String, `when`: List<MockCond>?, body: String): MockRule =
        MockRule(id, `when`, 200, "json", null, null, body, null, null)

    // ---------- 경로 매칭 ----------

    @Test
    fun `경로_파라미터_매칭`() {
        assertThat(MockRuntime.matchPath("/users/{id}", "/users/42")).containsEntry("id", "42")
        assertThat(MockRuntime.matchPath("/users/{id}", "/users")).isNull()
        assertThat(MockRuntime.matchPath("/users/{id}", "/users/42/orders")).isNull()
        assertThat(MockRuntime.matchPath("/a/{x}/b/{y}", "/a/1/b/2"))
            .containsEntry("x", "1").containsEntry("y", "2")
        assertThat(MockRuntime.matchPath("/exact", "/exact")).isEmpty() // 매칭 + 파라미터 없음
        assertThat(MockRuntime.matchPath("/exact", "/other")).isNull()
        // 끝 슬래시 정규화
        assertThat(MockRuntime.matchPath("/exact/", "/exact")).isEmpty()
    }

    @Test
    fun `메서드_ANY_와_정의순서_첫_매칭`() {
        val anyRoute = MockRoute("r1", "ANY", "/x", listOf(rule("u1", null, "any")))
        val getRoute = MockRoute("r2", "GET", "/x", listOf(rule("u2", null, "get")))
        val m = runtime.match(listOf(anyRoute, getRoute), req("GET", "/x"))
        assertThat(m).isPresent()
        assertThat(m.get().rule.id).isEqualTo("u1") // 정의 순서 우선
        assertThat(runtime.match(listOf(getRoute), req("POST", "/x"))).isEmpty() // 메서드 불일치
    }

    // ---------- 조건 ----------

    @Test
    fun `조건_연산자`() {
        val r = req(
            "POST", "/pay", mapOf("q" to "1"), mapOf("x-key" to "abc"),
            "otp=111111", mapOf("otp" to "111111")
        )
        assertThat(MockRuntime.conditionsPass(listOf(MockCond("body", "otp", "eq", "111111")), r, emptyMap())).isTrue()
        assertThat(MockRuntime.conditionsPass(listOf(MockCond("body", "otp", "eq", "0")), r, emptyMap())).isFalse()
        assertThat(MockRuntime.conditionsPass(listOf(MockCond("body", "otp", "ne", "0")), r, emptyMap())).isTrue()
        assertThat(MockRuntime.conditionsPass(listOf(MockCond("query", "q", "exists", null)), r, emptyMap())).isTrue()
        assertThat(MockRuntime.conditionsPass(listOf(MockCond("query", "none", "exists", null)), r, emptyMap())).isFalse()
        assertThat(MockRuntime.conditionsPass(listOf(MockCond("header", "X-Key", "contains", "b")), r, emptyMap())).isTrue()
        assertThat(MockRuntime.conditionsPass(listOf(MockCond("path", "id", "eq", "7")), r, mapOf("id" to "7"))).isTrue()
        // AND — 하나라도 거짓이면 전체 거짓
        assertThat(
            MockRuntime.conditionsPass(
                listOf(
                    MockCond("query", "q", "eq", "1"),
                    MockCond("body", "otp", "eq", "0")
                ), r, emptyMap()
            )
        ).isFalse()
    }

    @Test
    fun `조건규칙_분기와_기본_폴백`() {
        val route = MockRoute(
            "r1", "POST", "/otp", listOf(
                rule("ok", listOf(MockCond("body", "otp", "eq", "111111")), "{\"verified\":true}"),
                rule("no", null, "{\"verified\":false}")
            )
        )
        val ok = runtime.match(listOf(route), req("POST", "/otp", emptyMap(), emptyMap(), "", mapOf("otp" to "111111")))
        val no = runtime.match(listOf(route), req("POST", "/otp", emptyMap(), emptyMap(), "", mapOf("otp" to "000")))
        assertThat(ok.get().rule.id).isEqualTo("ok")
        assertThat(no.get().rule.id).isEqualTo("no")
    }

    // ---------- 템플릿 ----------

    @Test
    fun `템플릿_토큰_해석`() {
        val r = req(
            "POST", "/orders/77", mapOf("q" to "검색"), mapOf("x-mid" to "M1"),
            "{\"name\":\"김\"}", mapOf("name" to "김", "amount" to "48000")
        )
        val pp = mapOf("id" to "77")
        val out = runtime.template(
            "id={{path.id}} q={{query.q}} h={{header.X-Mid}} n={{body.name}} amt={{ body.amount }} m={{method}} raw={{body}} none={{query.nope}}",
            r, pp, 42L
        )
        assertThat(out).isEqualTo("id=77 q=검색 h=M1 n=김 amt=48000 m=POST raw={\"name\":\"김\"} none=")
        assertThat(runtime.template("{{seq}}", r, pp, 42L)).isEqualTo("42")
        assertThat(runtime.template("{{uuid}}", r, pp, 1L)).matches("[0-9a-f-]{36}")
        assertThat(runtime.template("{{now}}", r, pp, 1L)).isNotBlank()
        assertThat(runtime.template("{{unknown}}", r, pp, 1L)).isEmpty()
    }

    // ---------- 렌더 ----------

    @Test
    fun `렌더_문자셋과_ContentType`() {
        val euc = MockRule("u1", null, 200, "urlencoded", "EUC-KR", null, "custName=홍길동", null, null)
        val res = runtime.render(euc, req("GET", "/x"), emptyMap(), 1L)
        assertThat(res.contentType).isEqualTo("application/x-www-form-urlencoded; charset=EUC-KR")
        assertThat(res.body).isEqualTo("custName=홍길동".toByteArray(Charset.forName("EUC-KR")))

        val ms949 = MockRule("u2", null, 200, "text", "MS949", null, "가", null, null)
        assertThat(runtime.render(ms949, req("GET", "/x"), emptyMap(), 1L).contentType)
            .isEqualTo("text/plain; charset=windows-949") // JVM 정규명 x-windows-949 대신 IANA 명

        val json = MockRule("u3", null, 201, null, null, listOf(KV("X-Extra", "{{seq}}")), "{}", null, null)
        val jr = runtime.render(json, req("GET", "/x"), emptyMap(), 9L)
        assertThat(jr.status).isEqualTo(201)
        assertThat(jr.contentType).startsWith("application/json")
        assertThat(jr.headers).containsEntry("X-Extra", "9")
    }

    @Test
    fun `경로_디코딩_plus_리터럴_유지`() {
        // URLDecoder 와 달리 '+'는 공백으로 바뀌지 않는다(경로 파라미터 오염 방지)
        assertThat(MockHttp.decodePath("/items/A+B")).isEqualTo("/items/A+B")
        assertThat(MockHttp.decodePath("/items/A%20B")).isEqualTo("/items/A B")
        assertThat(MockHttp.decodePath("/user/%ED%99%8D%EA%B8%B8%EB%8F%99")).isEqualTo("/user/홍길동")
        assertThat(MockHttp.decodePath("/a/b/c")).isEqualTo("/a/b/c")
        // 잘못된 percent-encoding 은 원문 유지(예외 없이)
        assertThat(MockHttp.decodePath("/x/%zz")).isEqualTo("/x/%zz")
    }

    @Test
    fun `지연_상한과_콜백_렌더`() {
        val slow = MockRule("u1", null, 200, "json", null, null, "{}", 99_999, null)
        assertThat(runtime.render(slow, req("GET", "/x"), emptyMap(), 1L).delayMs)
            .isEqualTo(MockRuntime.MAX_DELAY_MS)

        val withCb = MockRule(
            "u2", null, 200, "json", null, null, "{}", null,
            MockCallback(500, "{{body.notiUrl}}", null, null, "tid={{seq}}", true)
        )
        val r = req("POST", "/x", emptyMap(), emptyMap(), "", mapOf("notiUrl" to "http://localhost:8787/cb/a/b"))
        val cb = runtime.render(withCb, r, emptyMap(), 7L).callback
        assertThat(cb).isNotNull()
        assertThat(cb!!.url).isEqualTo("http://localhost:8787/cb/a/b")
        assertThat(cb!!.method).isEqualTo("POST")
        assertThat(cb!!.body).isEqualTo("tid=7")
        assertThat(cb!!.retryUntilOk).isTrue()

        // notiUrl 이 요청에 없으면(빈 URL) 콜백 미발사
        val noCb = runtime.render(withCb, req("POST", "/x"), emptyMap(), 7L).callback
        assertThat(noCb).isNull()
    }
}
