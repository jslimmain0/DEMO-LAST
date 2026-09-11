package com.flowlink.secret

import ch.qos.logback.classic.Level
import ch.qos.logback.classic.Logger
import ch.qos.logback.classic.spi.ILoggingEvent
import ch.qos.logback.core.read.ListAppender
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.slf4j.LoggerFactory
import org.springframework.http.HttpMethod
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.test.web.client.ExpectedCount
import org.springframework.test.web.client.MockRestServiceServer
import org.springframework.test.web.client.match.MockRestRequestMatchers.header
import org.springframework.test.web.client.match.MockRestRequestMatchers.method
import org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo
import org.springframework.test.web.client.response.MockRestResponseCreators.withStatus
import org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess
import org.springframework.web.client.RestClient

/**
 * KV v2 시크릿 소스 — 조회 실패는 **첫 번만 WARN**(실제 요청 URL + 원인별 힌트), 같은 실패의 반복은 DEBUG,
 * 복구되면 INFO. `FLOWLINK_VAULT_ENABLED` 는 KV 오버레이 전용이라 Transit 만 쓰는 배포에서 켜 두면
 * 정책에 KV read 가 없어 403 이 나는데, 그 WARN 이 60초마다 반복되고 URL 도 `주소 마운트/경로` 로 찍혀 오해를 불렀다.
 */
class VaultSecretSourceTest {

    private val KV_URL = "http://vault.test:8200/v1/secret/data/flowlink"
    private var now = 1_000_000L
    private val logger = LoggerFactory.getLogger(VaultSecretSource::class.java) as Logger
    private val appender = ListAppender<ILoggingEvent>()
    private var prevLevel: Level? = null

    @BeforeEach
    fun attach() {
        prevLevel = logger.level
        logger.level = Level.DEBUG
        appender.start()
        logger.addAppender(appender)
    }

    @AfterEach
    fun detach() {
        logger.detachAppender(appender)
        logger.level = prevLevel
    }

    private fun props(enabled: Boolean = true, transit: Boolean = false) = VaultProperties(
        enabled = enabled, address = "http://vault.test:8200", token = "tok",
        mount = null, path = null, configPath = null, refreshSeconds = 60,
        transit = VaultProperties.Transit(enabled = transit, mount = null, key = null), approle = null,
    )

    private fun source(p: VaultProperties, server: (RestClient.Builder) -> MockRestServiceServer): Pair<VaultSecretSource, MockRestServiceServer> {
        val builder = RestClient.builder()
        val s = server(builder)
        return VaultSecretSource(p, VaultTokenSource.of(p), builder) { now } to s
    }

    private fun forbidden() = withStatus(HttpStatus.FORBIDDEN).contentType(MediaType.APPLICATION_JSON)
        .body("""{"errors":["1 error occurred:\n\t* permission denied\n\n"]}""")

    private fun levels(level: Level) = appender.list.filter { it.level == level }.map { it.formattedMessage }

    @Test
    fun `403 은 첫 실패만 WARN(실제 URL + Transit 힌트), 반복은 DEBUG, 복구는 INFO`() {
        val (src, server) = source(props(transit = true)) { b ->
            MockRestServiceServer.bindTo(b).build().apply {
                expect(ExpectedCount.times(2), requestTo(KV_URL))
                    .andExpect(method(HttpMethod.GET))
                    .andExpect(header("X-Vault-Token", "tok"))
                    .andRespond(forbidden())
                expect(requestTo(KV_URL))
                    .andRespond(withSuccess("""{"data":{"data":{"k":"v"},"metadata":{"version":1}}}""", MediaType.APPLICATION_JSON))
            }
        }
        assertThat(src.secrets()).isEmpty()            // 1차: 403 → WARN
        now += 61_000
        assertThat(src.secrets()).isEmpty()            // 2차(TTL 지난 뒤): 403 → DEBUG
        now += 61_000
        assertThat(src.secrets()).containsEntry("k", "v") // 3차: 복구 → INFO
        server.verify()

        val warns = levels(Level.WARN)
        assertThat(warns).hasSize(1)
        assertThat(warns[0]).contains("GET $KV_URL")
        assertThat(warns[0]).doesNotContain("8200 secret/flowlink")           // 옛 "주소 마운트/경로" 표기 금지
        assertThat(warns[0]).contains("403")
        assertThat(warns[0]).contains("FLOWLINK_VAULT_ENABLED")               // Transit 만 쓰면 끄라는 힌트
        assertThat(levels(Level.DEBUG)).hasSize(1)
        assertThat(levels(Level.INFO)).anyMatch { it.contains("복구") && it.contains(KV_URL) }
    }

    @Test
    fun `Transit 미사용 403 은 정책 추가 힌트`() {
        val (src, server) = source(props(transit = false)) { b ->
            MockRestServiceServer.bindTo(b).build().apply { expect(requestTo(KV_URL)).andRespond(forbidden()) }
        }
        assertThat(src.secrets()).isEmpty()
        server.verify()
        val warns = levels(Level.WARN)
        assertThat(warns).hasSize(1)
        assertThat(warns[0]).contains("secret/data/flowlink").contains("read")
        assertThat(warns[0]).doesNotContain("Transit 만")
    }

    @Test
    fun `enabled=false 면 네트워크 호출이 전혀 없다`() {
        val (src, server) = source(props(enabled = false)) { b -> MockRestServiceServer.bindTo(b).build() }
        assertThat(src.secrets()).isEmpty()
        assertThat(src.appSecret("jwt-secret")).isNull()
        server.verify()
        assertThat(appender.list).isEmpty()
    }
}
