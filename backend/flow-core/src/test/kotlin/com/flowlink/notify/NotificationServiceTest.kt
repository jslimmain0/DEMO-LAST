package com.flowlink.notify

import com.flowlink.common.tenant.TenantContext
import com.flowlink.settings.SettingsService
import com.sun.net.httpserver.HttpServer
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.test.context.TestPropertySource
import java.net.InetSocketAddress
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** 웹훅 알림 — 로컬 HTTP 스텁으로 받아 페이로드를 확인(플러그인 승인 흐름 + 실행 실패, 같은 post 경로). URL 없으면 no-op. */
@SpringBootTest
@TestPropertySource(properties = [
    "spring.datasource.url=jdbc:h2:mem:notifytest;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE",
    "spring.datasource.driver-class-name=org.h2.Driver",
    "spring.datasource.username=sa",
    "spring.datasource.password=",
    "spring.jpa.hibernate.ddl-auto=create-drop",
])
class NotificationServiceTest {
    @Autowired lateinit var notifier: NotificationService
    @Autowired lateinit var settings: SettingsService
    private val T = TenantContext.SHARED_FLOW_TENANT

    @AfterEach fun clear() { TenantContext.setTenantId(T); settings.put(SettingsService.KEY_NOTIFY_WEBHOOK, null); TenantContext.clear() }

    @Test fun `플러그인 승인 요청·실행 실패가 설정된 웹훅으로 간다`() {
        val bodies = CopyOnWriteArrayList<String>(); val got = CountDownLatch(2)
        val stub = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
            createContext("/hook") { ex -> bodies.add(ex.requestBody.readAllBytes().decodeToString()); ex.sendResponseHeaders(200, -1); ex.close(); got.countDown() }
            start()
        }
        try {
            TenantContext.setTenantId(T)
            settings.put(SettingsService.KEY_NOTIFY_WEBHOOK, "http://127.0.0.1:${stub.address.port}/hook")
            val sid = UUID.randomUUID()
            notifier.notifyPlugin(T, "PLUGIN_SUBMITTED", "🔌 플러그인 승인 요청 — 'DES' (#des-encrypt)", "des-encrypt", sid)
            notifier.notifyFailure(T, UUID.randomUUID(), UUID.randomUUID(), "boom")
            assertThat(got.await(5, TimeUnit.SECONDS)).isTrue()
            assertThat(bodies.first { it.contains("PLUGIN_SUBMITTED") }).contains("\"pluginId\":\"des-encrypt\"").contains(sid.toString()).contains("승인 요청")
            assertThat(bodies.first { it.contains("FAILED") }).contains("boom").contains("실행 실패")
        } finally { stub.stop(0); TenantContext.clear() }
    }

    @Test fun `URL 이 없으면 아무 데도 보내지 않는다(예외 없음)`() {
        TenantContext.setTenantId(T); settings.put(SettingsService.KEY_NOTIFY_WEBHOOK, null); TenantContext.clear()
        notifier.notifyPlugin(T, "PLUGIN_APPROVED", "x", "p", UUID.randomUUID()) // 백그라운드 no-op — 던지지 않으면 통과
    }
}
