package com.flowlink.assistant

import com.fasterxml.jackson.databind.ObjectMapper
import com.flowlink.common.json.JsonService
import com.flowlink.common.tenant.TenantContext
import com.flowlink.core.repository.AppSettingRepository
import com.flowlink.execution.config.ExecutionProperties
import com.flowlink.execution.engine.SsrfGuard
import com.flowlink.execution.engine.StateCrypto
import com.flowlink.security.GithubLoginEvent
import com.flowlink.settings.SettingsService
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.mockito.Mockito

/**
 * 앱 GitHub 로그인 → Copilot 연결 통합(AssistantOAuthService.onGithubLogin) 검증.
 * 로그인 이벤트로 받은 GitHub 토큰이 (event.tenant, 사용자별 키)로 암호화 저장되고 라운드트립되는지,
 * Copilot client 가 아니면 저장하지 않는지, 호출 후 TenantContext 가 복원되는지를 본다.
 */
class AssistantOAuthLinkTest {

    private val secret = "test-state-secret-123"

    /** 인메모리 SettingsService — put/get 시점의 TenantContext 를 캡처해 (tenant,key)로 격리 저장. */
    private class FakeSettings(repo: AppSettingRepository) : SettingsService(repo) {
        val store = LinkedHashMap<Pair<String, String>, String>()
        override fun get(key: String): String? = store[TenantContext.getTenantId() to key]
        override fun put(key: String, value: String?) {
            val k = TenantContext.getTenantId() to key
            if (value.isNullOrBlank()) store.remove(k) else store[k] = value.trim()
        }
    }

    private fun newService(settings: SettingsService): AssistantOAuthService {
        val props = ExecutionProperties(null, null, null, null, 0, secret, null)
        val ssrf = Mockito.mock(SsrfGuard::class.java)
        return AssistantOAuthService(settings, JsonService(ObjectMapper()), ssrf, props)
    }

    @AfterEach
    fun cleanup() = TenantContext.clear()

    private fun tokenKey(login: String) = "assistant.oauth.token:$login"

    @Test
    fun `Copilot client 로그인 토큰을 사용자별 키로 암호화 저장 + 라운드트립`() {
        val settings = FakeSettings(Mockito.mock(AppSettingRepository::class.java))
        val svc = newService(settings)

        svc.onGithubLogin(GithubLoginEvent("octocat", "gho_secret_token_xyz", "default", AssistantOAuthService.COPILOT_CLIENT_ID))

        val stored = settings.store["default" to tokenKey("octocat")]
        assertThat(stored).isNotNull()
        assertThat(stored).isNotEqualTo("gho_secret_token_xyz") // 평문 아님(암호화)
        // 어시스턴트가 같은 시크릿으로 복호화해 읽을 수 있어야 한다
        assertThat(StateCrypto(secret).decrypt(stored!!)).isEqualTo("gho_secret_token_xyz")
    }

    @Test
    fun `Copilot client 가 아니면 저장하지 않는다`() {
        val settings = FakeSettings(Mockito.mock(AppSettingRepository::class.java))
        val svc = newService(settings)

        svc.onGithubLogin(GithubLoginEvent("octocat", "gho_secret_token_xyz", "default", "some-other-client-id"))

        assertThat(settings.store).isEmpty()
    }

    @Test
    fun `저장은 이벤트의 테넌트로, 호출 후 TenantContext 는 복원된다`() {
        val settings = FakeSettings(Mockito.mock(AppSettingRepository::class.java))
        val svc = newService(settings)
        TenantContext.setTenantId("caller-tenant")

        svc.onGithubLogin(GithubLoginEvent("alice", "tok", "default", AssistantOAuthService.COPILOT_CLIENT_ID))

        // 저장은 event.tenant(default) 스코프로
        assertThat(settings.store.keys).containsExactly("default" to tokenKey("alice"))
        // 호출 후 호출자 테넌트로 복원
        assertThat(TenantContext.getTenantId()).isEqualTo("caller-tenant")
    }
}
