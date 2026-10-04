package com.flowlink.desktop

import com.flowlink.common.release.ReleaseVersion
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

class ReleaseVersionTest {
    @Test fun `배포 버전은 문자열 정렬이 아닌 각 숫자로 비교한다`() {
        assertThat(ReleaseVersion.compare("0.3.10", "0.3.9")).isPositive()
        assertThat(ReleaseVersion.compare("0.3.4", "0.3.4")).isZero()
        assertThat(ReleaseVersion.compare("0.3.4", "0.4.0")).isNegative()
        for (value in listOf("unknown", "0.3", "0.3.4-beta", " 0.3.4", "0.03.4", "-1.3.4", "9999999999999.0.0", "0.3.4;calc")) {
            assertThat(ReleaseVersion.isValid(value)).isFalse()
            assertThatThrownBy { ReleaseVersion.compare(value, "0.3.4") }.isInstanceOf(IllegalArgumentException::class.java)
        }
    }
}
