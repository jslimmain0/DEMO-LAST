package com.flowlink.mock;

import com.flowlink.mock.MockHttp.MockRequest;
import com.flowlink.mock.MockHttp.MockResponse;
import com.flowlink.mock.MockSpec.KV;
import com.flowlink.mock.MockSpec.MockCallback;
import com.flowlink.mock.MockSpec.MockCond;
import com.flowlink.mock.MockSpec.MockRoute;
import com.flowlink.mock.MockSpec.MockRule;
import org.junit.jupiter.api.Test;

import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;

class MockRuntimeTest {

    private final MockRuntime runtime = new MockRuntime();

    private static MockRequest req(String method, String path) {
        return req(method, path, Map.of(), Map.of(), "", Map.of());
    }

    private static MockRequest req(String method, String path, Map<String, String> query,
                                   Map<String, String> headers, String bodyText, Map<String, String> bodyFields) {
        return new MockRequest(method, path, query, headers, bodyText, bodyFields);
    }

    private static MockRule rule(String id, List<MockCond> when, String body) {
        return new MockRule(id, when, 200, "json", null, null, body, null, null);
    }

    // ---------- 경로 매칭 ----------

    @Test
    void 경로_파라미터_매칭() {
        assertThat(MockRuntime.matchPath("/users/{id}", "/users/42")).containsEntry("id", "42");
        assertThat(MockRuntime.matchPath("/users/{id}", "/users")).isNull();
        assertThat(MockRuntime.matchPath("/users/{id}", "/users/42/orders")).isNull();
        assertThat(MockRuntime.matchPath("/a/{x}/b/{y}", "/a/1/b/2"))
                .containsEntry("x", "1").containsEntry("y", "2");
        assertThat(MockRuntime.matchPath("/exact", "/exact")).isEmpty(); // 매칭 + 파라미터 없음
        assertThat(MockRuntime.matchPath("/exact", "/other")).isNull();
        // 끝 슬래시 정규화
        assertThat(MockRuntime.matchPath("/exact/", "/exact")).isEmpty();
    }

    @Test
    void 메서드_ANY_와_정의순서_첫_매칭() {
        MockRoute anyRoute = new MockRoute("r1", "ANY", "/x", List.of(rule("u1", null, "any")));
        MockRoute getRoute = new MockRoute("r2", "GET", "/x", List.of(rule("u2", null, "get")));
        Optional<MockRuntime.Match> m = runtime.match(List.of(anyRoute, getRoute), req("GET", "/x"));
        assertThat(m).isPresent();
        assertThat(m.get().rule().id()).isEqualTo("u1"); // 정의 순서 우선
        assertThat(runtime.match(List.of(getRoute), req("POST", "/x"))).isEmpty(); // 메서드 불일치
    }

    // ---------- 조건 ----------

    @Test
    void 조건_연산자() {
        MockRequest r = req("POST", "/pay", Map.of("q", "1"), Map.of("x-key", "abc"),
                "otp=111111", Map.of("otp", "111111"));
        assertThat(MockRuntime.conditionsPass(List.of(new MockCond("body", "otp", "eq", "111111")), r, Map.of())).isTrue();
        assertThat(MockRuntime.conditionsPass(List.of(new MockCond("body", "otp", "eq", "0")), r, Map.of())).isFalse();
        assertThat(MockRuntime.conditionsPass(List.of(new MockCond("body", "otp", "ne", "0")), r, Map.of())).isTrue();
        assertThat(MockRuntime.conditionsPass(List.of(new MockCond("query", "q", "exists", null)), r, Map.of())).isTrue();
        assertThat(MockRuntime.conditionsPass(List.of(new MockCond("query", "none", "exists", null)), r, Map.of())).isFalse();
        assertThat(MockRuntime.conditionsPass(List.of(new MockCond("header", "X-Key", "contains", "b")), r, Map.of())).isTrue();
        assertThat(MockRuntime.conditionsPass(List.of(new MockCond("path", "id", "eq", "7")), r, Map.of("id", "7"))).isTrue();
        // AND — 하나라도 거짓이면 전체 거짓
        assertThat(MockRuntime.conditionsPass(List.of(
                new MockCond("query", "q", "eq", "1"),
                new MockCond("body", "otp", "eq", "0")), r, Map.of())).isFalse();
    }

    @Test
    void 조건규칙_분기와_기본_폴백() {
        MockRoute route = new MockRoute("r1", "POST", "/otp", List.of(
                rule("ok", List.of(new MockCond("body", "otp", "eq", "111111")), "{\"verified\":true}"),
                rule("no", null, "{\"verified\":false}")));
        var ok = runtime.match(List.of(route), req("POST", "/otp", Map.of(), Map.of(), "", Map.of("otp", "111111")));
        var no = runtime.match(List.of(route), req("POST", "/otp", Map.of(), Map.of(), "", Map.of("otp", "000")));
        assertThat(ok.get().rule().id()).isEqualTo("ok");
        assertThat(no.get().rule().id()).isEqualTo("no");
    }

    // ---------- 템플릿 ----------

    @Test
    void 템플릿_토큰_해석() {
        MockRequest r = req("POST", "/orders/77", Map.of("q", "검색"), Map.of("x-mid", "M1"),
                "{\"name\":\"김\"}", Map.of("name", "김", "amount", "48000"));
        Map<String, String> pp = Map.of("id", "77");
        String out = runtime.template(
                "id={{path.id}} q={{query.q}} h={{header.X-Mid}} n={{body.name}} amt={{ body.amount }} m={{method}} raw={{body}} none={{query.nope}}",
                r, pp, 42);
        assertThat(out).isEqualTo("id=77 q=검색 h=M1 n=김 amt=48000 m=POST raw={\"name\":\"김\"} none=");
        assertThat(runtime.template("{{seq}}", r, pp, 42)).isEqualTo("42");
        assertThat(runtime.template("{{uuid}}", r, pp, 1)).matches("[0-9a-f-]{36}");
        assertThat(runtime.template("{{now}}", r, pp, 1)).isNotBlank();
        assertThat(runtime.template("{{unknown}}", r, pp, 1)).isEmpty();
    }

    // ---------- 렌더 ----------

    @Test
    void 렌더_문자셋과_ContentType() {
        MockRule euc = new MockRule("u1", null, 200, "urlencoded", "EUC-KR", null, "custName=홍길동", null, null);
        MockResponse res = runtime.render(euc, req("GET", "/x"), Map.of(), 1);
        assertThat(res.contentType()).isEqualTo("application/x-www-form-urlencoded; charset=EUC-KR");
        assertThat(res.body()).isEqualTo("custName=홍길동".getBytes(Charset.forName("EUC-KR")));

        MockRule ms949 = new MockRule("u2", null, 200, "text", "MS949", null, "가", null, null);
        assertThat(runtime.render(ms949, req("GET", "/x"), Map.of(), 1).contentType())
                .isEqualTo("text/plain; charset=windows-949"); // JVM 정규명 x-windows-949 대신 IANA 명

        MockRule json = new MockRule("u3", null, 201, null, null, List.of(new KV("X-Extra", "{{seq}}")), "{}", null, null);
        MockResponse jr = runtime.render(json, req("GET", "/x"), Map.of(), 9);
        assertThat(jr.status()).isEqualTo(201);
        assertThat(jr.contentType()).startsWith("application/json");
        assertThat(jr.headers()).containsEntry("X-Extra", "9");
    }

    @Test
    void 지연_상한과_콜백_렌더() {
        MockRule slow = new MockRule("u1", null, 200, "json", null, null, "{}", 99_999, null);
        assertThat(runtime.render(slow, req("GET", "/x"), Map.of(), 1).delayMs())
                .isEqualTo(MockRuntime.MAX_DELAY_MS);

        MockRule withCb = new MockRule("u2", null, 200, "json", null, null, "{}", null,
                new MockCallback(500, "{{body.notiUrl}}", null, null, "tid={{seq}}", true));
        MockRequest r = req("POST", "/x", Map.of(), Map.of(), "", Map.of("notiUrl", "http://localhost:8787/cb/a/b"));
        var cb = runtime.render(withCb, r, Map.of(), 7).callback();
        assertThat(cb).isNotNull();
        assertThat(cb.url()).isEqualTo("http://localhost:8787/cb/a/b");
        assertThat(cb.method()).isEqualTo("POST");
        assertThat(cb.body()).isEqualTo("tid=7");
        assertThat(cb.retryUntilOk()).isTrue();

        // notiUrl 이 요청에 없으면(빈 URL) 콜백 미발사
        var noCb = runtime.render(withCb, req("POST", "/x"), Map.of(), 7).callback();
        assertThat(noCb).isNull();
    }
}
