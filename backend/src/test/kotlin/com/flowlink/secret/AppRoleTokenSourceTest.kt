package com.flowlink.secret

import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.springframework.http.HttpMethod
import org.springframework.http.MediaType
import org.springframework.test.web.client.ExpectedCount
import org.springframework.test.web.client.MockRestServiceServer
import org.springframework.test.web.client.match.MockRestRequestMatchers.header
import org.springframework.test.web.client.match.MockRestRequestMatchers.jsonPath
import org.springframework.test.web.client.match.MockRestRequestMatchers.method
import org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo
import org.springframework.test.web.client.response.MockRestResponseCreators.withStatus
import org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess
import org.springframework.http.HttpStatus
import org.springframework.web.client.RestClient

/**
 * AppRole 토큰 소스 — 최초 접근 시 `auth/approle/login` 으로 토큰을 받고,
 * 수명 절반이 지나면 renew-self 로 연장, 갱신 실패/만료 시 재로그인한다(앱 재시작 불필요).
 */
class AppRoleTokenSourceTest {

    private var now = 1_000_000L // 제어 가능한 시계(ms)

    private fun props() = VaultProperties(
        enabled = true, address = "http://vault.test:8200", token = null,
        mount = null, path = null, configPath = null, refreshSeconds = null, transit = null,
        approle = VaultProperties.AppRole(roleId = "rid", secretId = "sid", mount = null),
    )

    private fun loginJson(token: String, ttlSec: Long) =
        """{"auth":{"client_token":"$token","lease_duration":$ttlSec,"renewable":true}}"""

    private fun source(server: (RestClient.Builder) -> MockRestServiceServer): Pair<AppRoleTokenSource, MockRestServiceServer> {
        val builder = RestClient.builder()
        val s = server(builder)
        return AppRoleTokenSource(props(), builder) { now } to s
    }

    @Test
    fun `최초 접근 시 approle login 으로 토큰을 받는다`() {
        val (src, server) = source { b ->
            MockRestServiceServer.bindTo(b).build().apply {
                expect(requestTo("http://vault.test:8200/v1/auth/approle/login"))
                    .andExpect(method(HttpMethod.POST))
                    .andExpect(jsonPath("$.role_id").value("rid"))
                    .andExpect(jsonPath("$.secret_id").value("sid"))
                    .andRespond(withSuccess(loginJson("tok-1", 180), MediaType.APPLICATION_JSON))
            }
        }
        assertThat(src.token()).isEqualTo("tok-1")
        server.verify()
    }

    @Test
    fun `수명 절반 전에는 캐시된 토큰을 재사용한다(추가 호출 없음)`() {
        val (src, server) = source { b ->
            MockRestServiceServer.bindTo(b).build().apply {
                expect(ExpectedCount.once(), requestTo("http://vault.test:8200/v1/auth/approle/login"))
                    .andRespond(withSuccess(loginJson("tok-1", 180), MediaType.APPLICATION_JSON))
            }
        }
        assertThat(src.token()).isEqualTo("tok-1")
        now += 60_000 // 60s < 90s(절반)
        assertThat(src.token()).isEqualTo("tok-1")
        server.verify() // login 1회 외 어떤 호출도 없어야 함
    }

    @Test
    fun `수명 절반이 지나면 renew-self 로 연장한다`() {
        val (src, server) = source { b ->
            MockRestServiceServer.bindTo(b).build().apply {
                expect(requestTo("http://vault.test:8200/v1/auth/approle/login"))
                    .andRespond(withSuccess(loginJson("tok-1", 180), MediaType.APPLICATION_JSON))
                expect(requestTo("http://vault.test:8200/v1/auth/token/renew-self"))
                    .andExpect(method(HttpMethod.POST))
                    .andExpect(header("X-Vault-Token", "tok-1"))
                    .andRespond(withSuccess(loginJson("tok-1", 180), MediaType.APPLICATION_JSON))
            }
        }
        src.token()
        now += 120_000 // 120s ≥ 90s(절반) — 갱신 트리거
        assertThat(src.token()).isEqualTo("tok-1")
        server.verify()
    }

    @Test
    fun `renew 실패 시 재로그인으로 새 토큰을 받는다`() {
        val (src, server) = source { b ->
            MockRestServiceServer.bindTo(b).build().apply {
                expect(requestTo("http://vault.test:8200/v1/auth/approle/login"))
                    .andRespond(withSuccess(loginJson("tok-1", 180), MediaType.APPLICATION_JSON))
                expect(requestTo("http://vault.test:8200/v1/auth/token/renew-self"))
                    .andRespond(withStatus(HttpStatus.FORBIDDEN).contentType(MediaType.APPLICATION_JSON).body("{}"))
                expect(requestTo("http://vault.test:8200/v1/auth/approle/login"))
                    .andRespond(withSuccess(loginJson("tok-2", 180), MediaType.APPLICATION_JSON))
            }
        }
        src.token()
        now += 120_000
        assertThat(src.token()).isEqualTo("tok-2")
        server.verify()
    }

    @Test
    fun `수명이 다 지난 토큰은 renew 없이 곧장 재로그인한다`() {
        val (src, server) = source { b ->
            MockRestServiceServer.bindTo(b).build().apply {
                expect(requestTo("http://vault.test:8200/v1/auth/approle/login"))
                    .andRespond(withSuccess(loginJson("tok-1", 180), MediaType.APPLICATION_JSON))
                expect(requestTo("http://vault.test:8200/v1/auth/approle/login"))
                    .andRespond(withSuccess(loginJson("tok-2", 180), MediaType.APPLICATION_JSON))
            }
        }
        src.token()
        now += 300_000 // 300s > 180s 만료
        assertThat(src.token()).isEqualTo("tok-2")
        server.verify() // renew-self 호출이 없어야 함
    }

    @Test
    fun `로그인 실패는 예외로 전파된다`() {
        val (src, _) = source { b ->
            MockRestServiceServer.bindTo(b).build().apply {
                expect(requestTo("http://vault.test:8200/v1/auth/approle/login"))
                    .andRespond(withStatus(HttpStatus.BAD_REQUEST).contentType(MediaType.APPLICATION_JSON).body("{\"errors\":[\"invalid secret id\"]}"))
            }
        }
        assertThatThrownBy { src.token() }.isInstanceOf(Exception::class.java)
    }
}
