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
    fun `MockSchemaPrompt 잔액조회 예시가 올바른 본문을 렌더한다`() {
        // 프롬프트 예시: 요청 본문 "0200"+계좌10 → 응답 "0210"+계좌에코+잔액12+코드"0000" (프리픽스는 서버 자동, 템플릿엔 없음)
        val req = "02001234567890".toByteArray(eucKr) // 전문코드(4) + 계좌(10)
        val body = TcpMockRegistry.renderTemplate("0210{{req:4:10}}0000001500000000", req, eucKr)
        assertEquals("021012345678900000001500000000", body) // 4+10+16 = 30바이트, 길이프리픽스는 서버가 "0030" 자동 부착
    }

    @Test
    fun plainTemplateAndDefaultCharset() {
        assertEquals("0000정상", TcpMockRegistry.renderTemplate("0000정상", ByteArray(0), eucKr))
        assertEquals("EUC-KR", TcpMockRegistry.charsetOf(null).name())
        assertEquals("UTF-8", TcpMockRegistry.charsetOf("UTF-8").name())
        assertEquals("EUC-KR", TcpMockRegistry.charsetOf("없는문자셋").name())
    }
}
