package com.flowlink.transform

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import java.nio.file.Files

class CodecRegistryTest {
    @Test
    fun `플러그인 디렉토리 없으면 코덱 0개 - 조회는 null`() {
        val dir = Files.createTempDirectory("no-plugins").resolve("none")
        val r = TransformRegistry(dir.toString())
        assertThat(r.codecs()).isEmpty()
        assertThat(r.codec("x")).isNull()
    }
}
