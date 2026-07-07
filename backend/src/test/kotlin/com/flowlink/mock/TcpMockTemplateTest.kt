package com.flowlink.mock

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import java.nio.charset.Charset

/** TCP mock 응답 템플릿({{req}}/{{req:오프셋:길이}} 바이트 슬라이스) 렌더 검증. */
class TcpMockTemplateTest {

    private val eucKr: Charset = Charset.forName("EUC-KR")

    @Test
    fun fullRequestEcho() {
        val req = "BAL1110123456789".toByteArray(eucKr)
        assertEquals("echo:BAL1110123456789", TcpMockRegistry.renderTemplate("echo:{{req}}", req, eucKr))
    }

    @Test
    fun byteSlice() {
        val req = "BAL1110123456789".toByteArray(eucKr)
        assertEquals("00-110123456789", TcpMockRegistry.renderTemplate("00-{{req:4:12}}", req, eucKr))
        assertEquals("BAL1", TcpMockRegistry.renderTemplate("{{ req:0:4 }}", req, eucKr))
    }

    @Test
    fun sliceClampAndKoreanBytes() {
        // EUC-KR 한글 2바이트 — 바이트 기준 슬라이스가 문자 경계에 맞으면 정상 디코딩
        val req = "00홍길동".toByteArray(eucKr) // 2 + 6 바이트
        assertEquals("홍길동", TcpMockRegistry.renderTemplate("{{req:2:6}}", req, eucKr))
        // 범위 초과는 잘라서(클램프) — 예외 없이
        assertEquals("동", TcpMockRegistry.renderTemplate("{{req:6:99}}", req, eucKr))
        assertEquals("", TcpMockRegistry.renderTemplate("{{req:99:4}}", req, eucKr))
    }

    @Test
    fun plainTemplateAndDefaultCharset() {
        assertEquals("0000정상", TcpMockRegistry.renderTemplate("0000정상", ByteArray(0), eucKr))
        assertEquals("EUC-KR", TcpMockRegistry.charsetOf(null).name())
        assertEquals("UTF-8", TcpMockRegistry.charsetOf("UTF-8").name())
        assertEquals("EUC-KR", TcpMockRegistry.charsetOf("없는문자셋").name())
    }
}
