package com.flowlink.transform

import com.flowlink.plugin.PluginsProperties
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import java.nio.file.Files

class CodecRegistryTest {
    @Test
    fun `플러그인 디렉토리 없으면 코덱 0개 - 조회는 null`() {
        val dir = Files.createTempDirectory("no-plugins").resolve("none")
        val r = TransformRegistry(PluginsProperties(dir.toString(), true))
        assertThat(r.codecs()).isEmpty()
        assertThat(r.codec("x")).isNull()
    }

    @Test
    fun `jar-enabled false 면 디렉토리에 JAR 이 있어도 로드하지 않는다`() {
        val dir = Files.createTempDirectory("jars-off")
        Files.write(dir.resolve("broken.jar"), byteArrayOf(1, 2, 3))
        val r = TransformRegistry(PluginsProperties(dir.toString(), false))
        assertThat(r.list()).isEmpty()
    }

    @Test
    fun `깨진 JAR 하나가 전체 로드를 막지 않는다`() {
        val dir = Files.createTempDirectory("jars-mixed")
        Files.write(dir.resolve("broken.jar"), byteArrayOf(1, 2, 3)) // zip 아님 → 이 JAR 만 실패
        val r = TransformRegistry(PluginsProperties(dir.toString(), true))
        assertThat(r.list()).isEmpty() // 예외 없이 끝나야 한다(깨진 것만 건너뜀)
    }

    @Test
    fun `스크립트 로더가 준 플러그인이 등록된다`() {
        val t = object : FlowTransform {
            override fun id() = "s1"; override fun label() = "s1"
            override fun apply(inputs: Map<String, String>, config: Map<String, String>) = mapOf("result" to "x")
        }
        val r = TransformRegistry(PluginsProperties("build/tmp/none", false), ScriptPluginLoader { listOf(t) })
        assertThat(r.get("s1")).isPresent
    }
}
