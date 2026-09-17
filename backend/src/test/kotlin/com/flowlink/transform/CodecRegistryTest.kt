package com.flowlink.transform

import com.flowlink.plugin.PluginsProperties
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import java.nio.file.Files
import java.util.jar.JarOutputStream
import java.util.zip.ZipEntry

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

        // broken.jar: 존재하지 않는 provider 지정 → ServiceConfigurationError 발생해도
        // 전체 로드가 실패하지 않아야 함
        JarOutputStream(Files.newOutputStream(dir.resolve("broken.jar"))).use { jar ->
            jar.putNextEntry(ZipEntry("META-INF/"))
            jar.closeEntry()
            jar.putNextEntry(ZipEntry("META-INF/services/"))
            jar.closeEntry()
            jar.putNextEntry(ZipEntry("META-INF/services/com.flowlink.transform.FlowTransform"))
            jar.write("com.flowlink.transform.NoSuchProvider\n".toByteArray())
            jar.closeEntry()
        }

        // 핵심: broken JAR이 있어도 TransformRegistry가 초기화되고
        // list() 호출이 예외를 던지지 않아야 함
        val r = TransformRegistry(PluginsProperties(dir.toString(), true))
        // 예외 없이 이 부분에 도달해야 함 - broken JAR은 건너뛰어짐
        assertThat(r.list()).isEmpty()
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

/** test classpath에 존재하는 provider — 다른 테스트들에서 사용할 수 있다. */
class JarProbe : FlowTransform {
    override fun id() = "jar-probe"
    override fun label() = "jar-probe"
    override fun apply(inputs: Map<String, String>, config: Map<String, String>) = mapOf("result" to "ok")
}
