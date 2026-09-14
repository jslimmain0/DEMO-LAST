package com.flowlink.execution.engine

import com.flowlink.core.graph.TcpRespField
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

class TcpRespPostProcessTest {
    private fun rf(trim: Boolean?, type: String?) = TcpRespField(id = "f", name = "x", length = 10, encoding = null, trim = trim, type = type)

    @Test fun `trim 미지정(레거시)은 원문 그대로`() { assertThat(TcpNodeExecutor.postProcess("000001500000", rf(null, null))).isEqualTo("000001500000") }
    @Test fun `문자 trim 은 후행 공백만`() { assertThat(TcpNodeExecutor.postProcess("홍길동   ", rf(true, "string"))).isEqualTo("홍길동") }
    @Test fun `숫자 trim 은 선행 0·공백 제거 후 Long`() { assertThat(TcpNodeExecutor.postProcess("000001500000", rf(true, "number"))).isEqualTo(1500000L) }
    @Test fun `숫자인데 소수점이면 Double, 숫자가 아니면 trim 된 문자열`() {
        assertThat(TcpNodeExecutor.postProcess("00012.50", rf(true, "number"))).isEqualTo(12.5)
        assertThat(TcpNodeExecutor.postProcess("  AB12 ", rf(true, "number"))).isEqualTo("AB12")
    }
    @Test fun `전부 0 이면 0`() { assertThat(TcpNodeExecutor.postProcess("0000", rf(true, "number"))).isEqualTo(0L) }
    @Test fun `type 만 number 이고 trim false 면 원문 파싱 시도`() { assertThat(TcpNodeExecutor.postProcess("0042", rf(false, "number"))).isEqualTo(42L) }
}
