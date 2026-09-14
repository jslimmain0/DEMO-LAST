package com.flowlink.mock

import com.flowlink.mock.TcpMockRegistry.FrameResult
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.net.SocketException
import java.net.SocketTimeoutException
import java.nio.charset.StandardCharsets

/**
 * TCP mock 수신(프레이밍) — 성공/정상종료/실패를 구분하고, **실패해도 받은 바이트를 돌려주는지**.
 * (조용히 끊겨 요청 기록에 아무것도 안 남던 결함의 회귀 방지)
 */
class TcpFrameReadTest {

    private val MAX = 1_000_000

    private fun stream(s: String): InputStream = ByteArrayInputStream(s.toByteArray(StandardCharsets.US_ASCII))

    /** 바이트를 다 주고 나면 닫히는 대신 타임아웃 나는 스트림(상대가 연결을 안 닫는 상황). */
    private fun hanging(s: String): InputStream {
        val src = ByteArrayInputStream(s.toByteArray(StandardCharsets.US_ASCII))
        return object : InputStream() {
            override fun read(): Int = throw UnsupportedOperationException()
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                val n = src.read(b, off, len)
                if (n < 0) throw SocketTimeoutException("Read timed out")
                return n
            }
        }
    }

    /** 바이트를 다 주고 나면 상대가 연결을 리셋하는 스트림(RST → SocketException). */
    private fun reset(s: String): InputStream {
        val src = ByteArrayInputStream(s.toByteArray(StandardCharsets.US_ASCII))
        return object : InputStream() {
            override fun read(): Int = throw UnsupportedOperationException()
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                val n = src.read(b, off, len)
                if (n < 0) throw SocketException("Connection reset")
                return n
            }
        }
    }

    @Test
    fun `정상_전문은_본문만_돌려준다`() {
        val r = TcpMockRegistry.readFrame(stream("00120200HELLO1234"), 4, false, MAX)
        assertThat(r).isInstanceOf(FrameResult.Ok::class.java)
        assertThat(String((r as FrameResult.Ok).body, StandardCharsets.US_ASCII)).isEqualTo("0200HELLO123")
    }

    @Test
    fun `프리픽스_포함_길이_규약`() {
        // 선언 0016 = 프리픽스 4 + 본문 12
        val r = TcpMockRegistry.readFrame(stream("00160200HELLO123"), 4, true, MAX)
        assertThat(String((r as FrameResult.Ok).body, StandardCharsets.US_ASCII)).isEqualTo("0200HELLO123")
    }

    @Test
    fun `상대가_닫으면_정상종료_기록없음`() {
        assertThat(TcpMockRegistry.readFrame(stream(""), 4, false, MAX)).isSameAs(FrameResult.Closed)
        // 프리픽스 모드에서 다음 전문 없이 유휴 타임아웃도 정상 종료(잡음 방지)
        assertThat(TcpMockRegistry.readFrame(hanging(""), 4, false, MAX)).isSameAs(FrameResult.Closed)
    }

    @Test
    fun `프리픽스가_숫자가_아니면_받은_바이트와_사유`() {
        val r = TcpMockRegistry.readFrame(stream("ORG0PAYLOAD"), 4, false, MAX)
        assertThat(r).isInstanceOf(FrameResult.Bad::class.java)
        val bad = r as FrameResult.Bad
        assertThat(bad.reason).contains("숫자가 아닙니다", "ORG0", "길이 프리픽스(바이트)")
        assertThat(String(bad.received, StandardCharsets.US_ASCII)).isEqualTo("ORG0")
    }

    @Test
    fun `프리픽스가_모자라면_받은_만큼_돌려준다`() {
        val bad = TcpMockRegistry.readFrame(stream("00"), 4, false, MAX) as FrameResult.Bad
        assertThat(bad.reason).contains("길이 프리픽스 4바이트를 기다렸지만 2바이트")
        assertThat(bad.received).hasSize(2)
    }

    @Test
    fun `선언_길이가_음수거나_상한을_넘으면_실패`() {
        // 프리픽스 포함 길이인데 선언이 프리픽스보다 작다
        val neg = TcpMockRegistry.readFrame(stream("0002X"), 4, true, MAX) as FrameResult.Bad
        assertThat(neg.reason).contains("선언 길이 -2", "프리픽스 포함 길이")
        val over = TcpMockRegistry.readFrame(stream("9999X"), 4, false, 100) as FrameResult.Bad
        assertThat(over.reason).contains("본문 길이 9999", "상한(100)")
        assertThat(String(over.received, StandardCharsets.US_ASCII)).isEqualTo("9999")
    }

    @Test
    fun `본문이_모자라면_부분_바이트를_그대로_돌려준다`() {
        // 사용자의 실제 오설정: 보낸 쪽 길이가 자기 자신 포함(0200=196+4)인데 mock 은 포함 아님으로 설정
        val body = "X".repeat(196)
        val bad = TcpMockRegistry.readFrame(stream("0200$body"), 4, false, MAX) as FrameResult.Bad
        assertThat(bad.reason).contains("본문 200바이트를 기다렸지만 196바이트", "'프리픽스 포함 길이'를 켜세요")
        assertThat(String(bad.received, StandardCharsets.US_ASCII)).isEqualTo("0200$body") // 프리픽스 포함 실제 수신분
    }

    @Test
    fun `본문_수신_중_타임아웃도_부분_바이트_보존`() {
        val bad = TcpMockRegistry.readFrame(hanging("0010ABCDE"), 4, false, MAX) as FrameResult.Bad
        assertThat(bad.reason).contains("본문 10바이트를 기다렸지만 5바이트")
        assertThat(String(bad.received, StandardCharsets.US_ASCII)).isEqualTo("0010ABCDE")
    }

    @Test
    fun `전송_중_연결이_끊기면_RST_부분_바이트를_보존한다`() {
        // 프리픽스는 왔고 본문 전송 중 상대가 리셋(SocketException) — 예전엔 밖으로 던져져 모아둔 바이트가 버려졌다
        val bad = TcpMockRegistry.readFrame(reset("0010ABC"), 4, false, MAX) as FrameResult.Bad
        assertThat(bad.reason).contains("본문 10바이트를 받는 중 연결이 끊겼습니다", "3바이트 수신", "리셋")
        assertThat(String(bad.received, StandardCharsets.US_ASCII)).isEqualTo("0010ABC")
        // 프리픽스 도중 리셋
        val pre = TcpMockRegistry.readFrame(reset("00"), 4, false, MAX) as FrameResult.Bad
        assertThat(pre.reason).contains("길이 프리픽스 4바이트를 받는 중 연결이 끊겼습니다")
        assertThat(pre.received).hasSize(2)
        // 한 바이트도 못 받고 리셋되면 정상 종료 취급(기록 잡음 방지)
        assertThat(TcpMockRegistry.readFrame(reset(""), 4, false, MAX)).isSameAs(FrameResult.Closed)
        // EOF 모드에서도 부분 보존
        val eof = TcpMockRegistry.readFrame(reset("0200RAW"), 0, false, MAX) as FrameResult.Bad
        assertThat(eof.reason).contains("전문 7바이트를 받는 중 연결이 끊겼습니다")
        assertThat(String(eof.received, StandardCharsets.US_ASCII)).isEqualTo("0200RAW")
    }

    @Test
    fun `EOF_모드는_연결이_닫힐_때까지_전부`() {
        val ok = TcpMockRegistry.readFrame(stream("0200RAW"), 0, false, MAX) as FrameResult.Ok
        assertThat(String(ok.body, StandardCharsets.US_ASCII)).isEqualTo("0200RAW")
        assertThat(TcpMockRegistry.readFrame(stream(""), 0, false, MAX)).isSameAs(FrameResult.Closed)
        // 안 닫고 기다리는 상대 — 지금까지 받은 전문을 사유와 함께
        val bad = TcpMockRegistry.readFrame(hanging("0200RAW"), 0, false, MAX) as FrameResult.Bad
        assertThat(bad.reason).contains("연결을 닫지 않아", "길이 프리픽스(바이트)")
        assertThat(String(bad.received, StandardCharsets.US_ASCII)).isEqualTo("0200RAW")
    }
}
