package com.flowlink.desktop

import com.fasterxml.jackson.databind.ObjectMapper
import com.flowlink.execution.engine.StateCrypto
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Path

class DesktopSessionTest {
    @TempDir lateinit var directory: Path

    @Test
    fun `개인 키와 장치 ID는 유지되지만 접근 토큰은 재시작 때 바뀐다`() {
        var key = ""; var id = ""; var token = ""; var encrypted = ""
        DesktopSession(directory.toString(), 18180).use { session ->
            key = session.encryptionKey; id = session.deviceId; token = session.token
            encrypted = StateCrypto(key).encrypt("private-secret")
            session.publish(ObjectMapper())
            val ticket = session.browserUrl().substringAfter("ticket=")
            assertThat(session.claimTicket(ticket)).isTrue()
            assertThat(session.claimTicket(ticket)).isFalse()
            assertThat(session.accepts("wrong")).isFalse()
        }
        DesktopSession(directory.toString(), 18180).use { session ->
            assertThat(session.encryptionKey).isEqualTo(key)
            assertThat(session.deviceId).isEqualTo(id)
            assertThat(session.token).isNotEqualTo(token)
            assertThat(StateCrypto(session.encryptionKey).decrypt(encrypted)).isEqualTo("private-secret")
        }
    }

}
