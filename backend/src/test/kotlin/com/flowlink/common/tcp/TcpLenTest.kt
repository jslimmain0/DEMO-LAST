package com.flowlink.common.tcp

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import java.nio.charset.Charset

/**
 * 전문 길이 토큰 문법/2패스 검증 — `{{len}}` `{{len:N}}` `{{len:frame}}` `{{len:frame:N}}`.
 * 핵심 규약: (1) 알 수 없는 형태는 **원문 유지**, (2) 템플릿 모드에서 **치환 후 바이트 길이 = 토큰이 내놓은 숫자**.
 */
class TcpLenTest {

    private val euc: Charset = Charset.forName("EUC-KR")

    @Test
    fun `bare 는 10진수 그대로, N 은 0 패딩`() {
        assertThat(TcpLen.resolve("{{len}}", 204, 208)).isEqualTo("204")
        assertThat(TcpLen.resolve("{{len:4}}", 204, 208)).isEqualTo("0204")
        assertThat(TcpLen.resolve("{{len:8}}", 204, 208)).isEqualTo("00000204")
        assertThat(TcpLen.resolve("{{len:4}}", 7, 11)).isEqualTo("0007")
    }

    @Test
    fun `frame 은 프리픽스 포함 전체 바이트`() {
        assertThat(TcpLen.resolve("{{len:frame}}", 204, 208)).isEqualTo("208")
        assertThat(TcpLen.resolve("{{len:frame:4}}", 204, 208)).isEqualTo("0208")
        assertThat(TcpLen.resolve("{{len:frame:6}}", 204, 208)).isEqualTo("000208")
    }

    @Test
    fun `텍스트와 섞여도 그 자리만 치환`() {
        assertThat(TcpLen.resolve("ABC{{len:4}}", 204, 208)).isEqualTo("ABC0204")
        assertThat(TcpLen.resolve("{{len:4}}0200{{len:frame:4}}끝", 204, 208)).isEqualTo("020402000208끝")
        assertThat(TcpLen.resolve("{{ len : frame : 4 }}", 204, 208)).isEqualTo("0208") // 공백 허용
    }

    @Test
    fun `알 수 없는 형태는 건드리지 않는다`() {
        for (t in listOf("{{length}}", "{{len:x}}", "{{lenx}}", "{{ len:frames }}", "{{LEN}}", "{{len:4:5}}", "{{len:1234}}")) {
            assertThat(TcpLen.resolve(t, 204, 208)).describedAs(t).isEqualTo(t)
            assertThat(TcpLen.hasToken(t)).describedAs(t).isFalse()
        }
        assertThat(TcpLen.resolve("토큰 없음", 204, 208)).isEqualTo("토큰 없음")
        assertThat(TcpLen.resolve(null, 204, 208)).isEmpty()
    }

    @Test
    fun `hasToken 과 isToken`() {
        assertThat(TcpLen.hasToken("길이=({{len:frame}})")).isTrue()
        assertThat(TcpLen.hasToken("{{ x@body }}")).isFalse()
        assertThat(TcpLen.isToken("len")).isTrue()
        assertThat(TcpLen.isToken("len:4")).isTrue()
        assertThat(TcpLen.isToken("len : frame : 4")).isTrue()
        assertThat(TcpLen.isToken("length")).isFalse()
        assertThat(TcpLen.isToken("x@body")).isFalse()
    }

    @Test
    fun `N 자리를 넘치면 하위 N 자리만 - 폭 불변`() {
        assertThat(TcpLen.resolve("{{len:2}}", 204, 208)).isEqualTo("04")
        assertThat(TcpLen.resolve("{{len:2}}", 204, 208)).hasSize(2)
    }

    @Test
    fun `resolveBare false 면 bare 만 원문 유지 - 명시형은 그대로 치환`() {
        assertThat(TcpLen.resolve("{{len}}", 204, 208, false)).isEqualTo("{{len}}")
        assertThat(TcpLen.resolve("{{ len }}|{{len:4}}|{{len:frame}}", 204, 208, false)).isEqualTo("{{ len }}|0204|208")
        assertThat(TcpLen.resolve("{{len}}", 204, 208, true)).isEqualTo("204")
    }

    @Test
    fun `hasBareToken 은 bare 형태만 잡는다`() {
        assertThat(TcpLen.hasBareToken("{{len}}")).isTrue()
        assertThat(TcpLen.hasBareToken("앞{{ len }}뒤")).isTrue()
        assertThat(TcpLen.hasBareToken("{{len:4}}")).isFalse()
        assertThat(TcpLen.hasBareToken("{{len:frame}}")).isFalse()
        assertThat(TcpLen.hasBareToken("{{length}}")).isFalse()
        assertThat(TcpLen.hasBareToken(null)).isFalse()
    }

    @Test
    fun `템플릿 2패스 - 치환 결과의 바이트 길이가 토큰이 내놓은 숫자와 같다`() {
        // 본문 = 4자리 길이 + 고정 텍스트. 자리표시자(0000)와 최종 숫자의 폭이 같아 길이가 안 변한다.
        val t = "{{len:4}}0200ABCDEF"
        val out = TcpLen.resolveRendered(t, 4, euc)
        assertThat(out.toByteArray(euc).size).isEqualTo(out.substring(0, 4).toInt())
        assertThat(out).isEqualTo("00140200ABCDEF")
    }

    @Test
    fun `템플릿 2패스 - frame 은 프리픽스를 더한 값`() {
        val out = TcpLen.resolveRendered("{{len:4}}|{{len:frame:4}}|X", 4, euc)
        val parts = out.split("|")
        assertThat(parts[0].toInt()).isEqualTo(out.toByteArray(euc).size)
        assertThat(parts[1].toInt()).isEqualTo(out.toByteArray(euc).size + 4)
        assertThat(TcpLen.resolveRendered("{{len:4}}X", 0, euc)).isEqualTo("0005X") // 프리픽스 없으면 frame = len
    }

    @Test
    fun `템플릿 2패스 - bare 자리수는 결과와 일관된 고정점`() {
        // 본문이 9바이트 → "9"(1자리), 10바이트 이상이면 2자리 — 자리수를 늘리면 본문도 길어지는 경계를 정확히 잡는다.
        val a = TcpLen.resolveRendered("{{len}}12345678", 0, euc)     // 1 + 8 = 9
        assertThat(a).isEqualTo("912345678")
        assertThat(a.toByteArray(euc).size).isEqualTo(9)
        val b = TcpLen.resolveRendered("{{len}}123456789", 0, euc)    // 1+9=10 → 2자리 → 11
        assertThat(b).isEqualTo("11123456789")
        assertThat(b.toByteArray(euc).size).isEqualTo(11)
        assertThat(b.substring(0, 2).toInt()).isEqualTo(b.toByteArray(euc).size)
    }

    @Test
    fun `템플릿 2패스 - 한글(EUC-KR 2바이트) 길이도 바이트 기준`() {
        val out = TcpLen.resolveRendered("{{len:4}}홍길동", 4, euc)
        assertThat(out).isEqualTo("0010홍길동") // 4 + 6바이트
        assertThat(out.toByteArray(euc).size).isEqualTo(10)
    }

    @Test
    fun `템플릿 2패스 - 토큰이 없으면 원문 그대로`() {
        assertThat(TcpLen.resolveRendered("0200홍길동", 4, euc)).isEqualTo("0200홍길동")
        assertThat(TcpLen.resolveRendered("", 4, euc)).isEmpty()
        assertThat(TcpLen.resolveRendered(null, 4, euc)).isEmpty()
    }
}
