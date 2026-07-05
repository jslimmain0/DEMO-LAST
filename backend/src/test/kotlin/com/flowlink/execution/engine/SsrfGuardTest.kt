package com.flowlink.execution.engine

import com.flowlink.execution.config.ExecutionProperties
import org.junit.jupiter.api.Assertions.assertDoesNotThrow
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.function.Executable
import java.net.URI

/** SSRF 가드 — 사설/메타데이터/비허용 스킴 차단(네트워크 DNS 불필요한 케이스만). */
class SsrfGuardTest {

    private fun guard(allowLoopback: Boolean = false): SsrfGuard {
        val props = ExecutionProperties(
            null,
            ExecutionProperties.Ssrf(
                true, true, allowLoopback,
                listOf("169.254.169.254"), listOf("http", "https")
            ),
            null,
            200
        )
        return SsrfGuard(props)
    }

    @Test
    fun blocksCloudMetadataHost() {
        assertThrows(SsrfBlockedException::class.java) {
            guard().check(URI.create("http://169.254.169.254/latest/meta-data/"))
        }
    }

    @Test
    fun blocksLoopback() {
        assertThrows(SsrfBlockedException::class.java) {
            guard().check(URI.create("http://127.0.0.1:8080/internal"))
        }
    }

    @Test
    fun allowsLoopbackWhenConfigured() {
        // allow-loopback=true → localhost/127.0.0.1 허용(로컬 배포)
        assertDoesNotThrow(Executable { guard(true).check(URI.create("http://127.0.0.1:8080/internal")) })
        assertDoesNotThrow(Executable { guard(true).check(URI.create("http://localhost:3000/api")) })
    }

    @Test
    fun allowLoopbackStillBlocksPrivateRange() {
        // allow-loopback 이어도 사설망(192.168/10.x)은 여전히 차단
        assertThrows(SsrfBlockedException::class.java) {
            guard(true).check(URI.create("http://192.168.0.10/"))
        }
    }

    @Test
    fun blocksPrivateRange() {
        assertThrows(SsrfBlockedException::class.java) {
            guard().check(URI.create("http://10.0.0.5/"))
        }
        assertThrows(SsrfBlockedException::class.java) {
            guard().check(URI.create("http://192.168.1.1/"))
        }
    }

    @Test
    fun blocksDisallowedScheme() {
        assertThrows(SsrfBlockedException::class.java) {
            guard().check(URI.create("ftp://example.com/"))
        }
        assertThrows(SsrfBlockedException::class.java) {
            guard().check(URI.create("file:///etc/passwd"))
        }
    }

    @Test
    fun allowsPublicLiteralIp() {
        // 8.8.8.8 은 공인 대역 → 통과(외부 DNS 호출 없음)
        assertDoesNotThrow(Executable { guard().check(URI.create("https://8.8.8.8/")) })
    }
}
