package com.flowlink.desktop

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.flowlink.common.error.BadRequestException
import com.flowlink.settings.SettingsService
import org.assertj.core.api.Assertions.*
import org.junit.jupiter.api.Test
import org.mockito.Mockito
import java.util.UUID

class DesktopEnvironmentBindingsTest {
    private val values = mutableMapOf<String, String?>()
    private val settings = Mockito.mock(SettingsService::class.java).also { mock ->
        Mockito.`when`(mock.get(Mockito.anyString())).thenAnswer { values[it.getArgument(0)] }
        Mockito.doAnswer { values[it.getArgument(0)] = it.getArgument(1); null }.`when`(mock).put(Mockito.anyString(), Mockito.anyString())
    }
    private val connection = Mockito.mock(DesktopConnection::class.java)
    private val api = DesktopEnvironmentBindings(settings, connection, jacksonObjectMapper())
    private val owner = UUID.randomUUID().toString()
    private val target = "server:${UUID.randomUUID()}"
    private val server = "https://flowlink.example.internal"
    init { account("alice") }
    private fun account(name: String) { Mockito.`when`(connection.view()).thenReturn(DesktopConnection.View(server, "", name, true)) }
    private fun read(env: String = "dev", space: String = owner, user: String = "alice") = api.get("server", space, env, server, user)

    @Test fun `같은 공간 환경의 선택을 재사용하며 명시 공통과 미지정을 구분한다`() {
        val saved = api.put(DesktopEnvironmentBindings.Save("server", owner, "dev", mapOf("local" to "pc-dev", target to ""), ""), server, "alice")
        assertThat(saved.bindings).containsEntry(target, "").containsEntry("local", "pc-dev")
        assertThat(saved.revision).isNotBlank()
        assertThat(read()).isEqualTo(saved)
        assertThat(read("qa").bindings).isEmpty()
        assertThat(read(space = UUID.randomUUID().toString()).bindings).isEmpty()
        account("bob")
        assertThat(read(user = "bob").bindings).isEmpty()
        account("alice")
        assertThat(read()).isEqualTo(saved)
    }

    @Test fun `오래된 화면과 변경된 서버 계정은 기존 선택을 덮어쓰지 않는다`() {
        api.put(DesktopEnvironmentBindings.Save("server", owner, "dev", mapOf("local" to "pc-dev"), ""), server, "alice")
        assertThatThrownBy { api.put(DesktopEnvironmentBindings.Save("server", owner, "dev", mapOf("local" to "wrong"), ""), server, "alice") }
            .isInstanceOf(DesktopEnvironmentBindings.Conflict::class.java)
        assertThatThrownBy { api.get("server", owner, "dev", "https://other.example", "alice") }
            .isInstanceOf(DesktopEnvironmentBindings.Conflict::class.java)
        account("bob")
        assertThatThrownBy { read() }.isInstanceOf(DesktopEnvironmentBindings.Conflict::class.java)
        account("alice")
        assertThat(read().bindings).containsEntry("local", "pc-dev")
    }

    @Test fun `잘못된 목적지와 값은 저장하지 않고 개인 오프라인 선택은 허용한다`() {
        assertThatThrownBy { api.put(DesktopEnvironmentBindings.Save("server", owner, "dev", mapOf("server:any-team" to "x"), ""), server, "alice") }
            .isInstanceOf(BadRequestException::class.java)
        Mockito.`when`(connection.view()).thenReturn(DesktopConnection.View("", "", null, false))
        val saved = api.put(DesktopEnvironmentBindings.Save("local", "local", "dev", mapOf("local" to ""), ""), "", "")
        assertThat(saved.bindings).containsEntry("local", "")
        assertThatThrownBy { api.get("server", owner, "dev", "", "") }.isInstanceOf(BadRequestException::class.java)
    }
}
