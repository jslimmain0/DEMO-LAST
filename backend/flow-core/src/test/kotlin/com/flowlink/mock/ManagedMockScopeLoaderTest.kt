package com.flowlink.mock

import com.flowlink.common.error.BadRequestException
import com.flowlink.common.tenant.TenantContext
import com.flowlink.environment.EnvironmentService
import com.flowlink.secret.SecretService
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.mockito.Mockito.*
import org.springframework.http.HttpStatus
import org.springframework.web.server.ResponseStatusException
import java.util.UUID

class ManagedMockScopeLoaderTest {
    private val secrets = mock(SecretService::class.java)
    private val environments = mock(EnvironmentService::class.java)
    private val loader = ManagedMockScopeLoader(secrets, environments)
    private val workspace = UUID.randomUUID()

    @AfterEach fun clear() = TenantContext.clear()

    @Test fun `미리보기와 Mock은 없는 환경을 공통 환경으로 대체하지 않는다`() {
        TenantContext.setTenantId("previous")
        assertThrows<BadRequestException> { loader.load("selected", "missing", workspace) }
        verifyNoInteractions(secrets)
        assertThat(TenantContext.getTenantId()).isEqualTo("previous")
    }

    @Test fun `시크릿이나 환경 조회 실패는 빈 값으로 실행하지 않고 안전한 오류로 중단한다`() {
        `when`(environments.exists("dev", workspace)).thenReturn(true)
        `when`(secrets.activeSecrets("dev", workspace)).thenThrow(IllegalStateException("private-key-detail"))
        TenantContext.setTenantId("previous")
        val error = assertThrows<ResponseStatusException> { loader.load("selected", "dev", workspace) }
        assertThat(error.statusCode).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE)
        assertThat(error.reason).doesNotContain("private-key-detail")
        assertThat(TenantContext.getTenantId()).isEqualTo("previous")
        doReturn(emptyMap<String, String>()).`when`(secrets).activeSecrets("dev", workspace)
        `when`(environments.vars("dev", workspace)).thenThrow(IllegalStateException("database-detail"))
        assertThrows<ResponseStatusException> { loader.load("selected", "dev", workspace) }
        assertThat(TenantContext.getTenantId()).isEqualTo("previous")
    }
}
