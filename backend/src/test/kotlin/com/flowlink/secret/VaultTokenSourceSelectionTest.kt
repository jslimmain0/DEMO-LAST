package com.flowlink.secret

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

/**
 * 토큰 소스 선택 규칙 — AppRole(role_id+secret_id)이 설정되면 AppRole 로그인,
 * 아니면 기존 static 토큰(무회귀), 둘 다 없으면 미구성(available=false).
 */
class VaultTokenSourceSelectionTest {

    private fun props(token: String?, roleId: String?, secretId: String?) = VaultProperties(
        enabled = true, address = null, token = token,
        mount = null, path = null, configPath = null, refreshSeconds = null, transit = null,
        approle = VaultProperties.AppRole(roleId = roleId, secretId = secretId, mount = null),
    )

    @Test
    fun `approle 이 설정되면 AppRoleTokenSource`() {
        val src = VaultTokenSource.of(props(token = null, roleId = "rid", secretId = "sid"))
        assertThat(src).isInstanceOf(AppRoleTokenSource::class.java)
        assertThat(src.available).isTrue()
    }

    @Test
    fun `approle 이 static 토큰보다 우선한다`() {
        val src = VaultTokenSource.of(props(token = "tkn", roleId = "rid", secretId = "sid"))
        assertThat(src).isInstanceOf(AppRoleTokenSource::class.java)
    }

    @Test
    fun `approle 미설정이면 static 토큰(무회귀)`() {
        val src = VaultTokenSource.of(props(token = "tkn", roleId = null, secretId = null))
        assertThat(src.available).isTrue()
        assertThat(src.token()).isEqualTo("tkn")
    }

    @Test
    fun `둘 다 없으면 미구성`() {
        val src = VaultTokenSource.of(props(token = null, roleId = null, secretId = null))
        assertThat(src.available).isFalse()
    }
}
