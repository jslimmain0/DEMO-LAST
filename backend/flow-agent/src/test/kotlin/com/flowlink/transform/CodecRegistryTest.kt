package com.flowlink.transform

import com.flowlink.plugin.PluginsProperties
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatCode
import org.junit.jupiter.api.Test
import java.nio.file.Files
import java.util.jar.JarOutputStream
import java.util.UUID
import java.util.zip.ZipEntry

class CodecRegistryTest {
    @Test
    fun `개인 호스트에서는 기존 승인본과 JAR 설정으로도 플러그인을 로드하지 않는다`() {
        val scope = object : TransformScope {
            override val pluginsEnabled = false
            override fun key(id: UUID?) = "personal"
        }
        val registry = TransformRegistry(PluginsProperties("build/tmp/none", true), ScriptPluginLoader { error("개인 승인본을 읽으면 안 됩니다.") }, scope)
        registry.reload()
        assertThat(registry.list()).isEmpty()
        assertThat(registry.codecs()).isEmpty()
        assertThat(registry.get("old")).isEmpty()
        assertThat(registry.fingerprint("old")).isNull()
    }
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
    fun `좋은 JAR 만으로도 로드된다`() {
        val dir = Files.createTempDirectory("jars-good")

        // good.jar: test classpath에 존재하는 provider 지정 (JarProbe)
        JarOutputStream(Files.newOutputStream(dir.resolve("good.jar"))).use { jar ->
            jar.putNextEntry(ZipEntry("META-INF/"))
            jar.closeEntry()
            jar.putNextEntry(ZipEntry("META-INF/services/"))
            jar.closeEntry()
            jar.putNextEntry(ZipEntry("META-INF/services/com.flowlink.transform.FlowTransform"))
            jar.write("com.flowlink.transform.JarProbe\n".toByteArray())
            jar.closeEntry()
        }

        val r = TransformRegistry(PluginsProperties(dir.toString(), true))
        assertThat(r.get("jar-probe")).isPresent
    }

    @Test
    fun `깨진 JAR 하나가 전체 로드를 막지 않는다`() {
        val dir = Files.createTempDirectory("jars-mixed")

        // broken.jar: 존재하지 않는 provider 지정 → ServiceConfigurationError 발생
        JarOutputStream(Files.newOutputStream(dir.resolve("broken.jar"))).use { jar ->
            jar.putNextEntry(ZipEntry("META-INF/"))
            jar.closeEntry()
            jar.putNextEntry(ZipEntry("META-INF/services/"))
            jar.closeEntry()
            jar.putNextEntry(ZipEntry("META-INF/services/com.flowlink.transform.FlowTransform"))
            jar.write("com.flowlink.transform.NoSuchProvider\n".toByteArray())
            jar.closeEntry()
        }

        // good.jar: test classpath에 존재하는 provider 지정 (JarProbe)
        JarOutputStream(Files.newOutputStream(dir.resolve("good.jar"))).use { jar ->
            jar.putNextEntry(ZipEntry("META-INF/"))
            jar.closeEntry()
            jar.putNextEntry(ZipEntry("META-INF/services/"))
            jar.closeEntry()
            jar.putNextEntry(ZipEntry("META-INF/services/com.flowlink.transform.FlowTransform"))
            jar.write("com.flowlink.transform.JarProbe\n".toByteArray())
            jar.closeEntry()
        }

        // 핵심: broken JAR은 건너뛰고 good JAR에서 jar-probe를 로드해야 함
        val r = TransformRegistry(PluginsProperties(dir.toString(), true))
        // 예외 없이 로드 완료 - good JAR에서 jar-probe를 로드했어야 함
        assertThat(r.get("jar-probe")).isPresent
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

    @Test
    fun `스크립트 로더가 던지면 reload 는 삼키고 이전 등록을 유지한다`() {
        val t = object : FlowTransform {
            override fun id() = "s1"; override fun label() = "s1"
            override fun apply(inputs: Map<String, String>, config: Map<String, String>) = mapOf("result" to "x")
        }
        var down = false
        val r = TransformRegistry(PluginsProperties("build/tmp/none", false), ScriptPluginLoader { if (down) throw RuntimeException("db down") else listOf(t) })
        assertThat(r.get("s1")).isPresent
        down = true
        assertThatCode { r.reload() }.doesNotThrowAnyException()
        assertThat(r.get("s1")).isPresent
    }

    @Test
    fun `호스트 공간 해석으로 개인 기본값과 명시 공간을 구분한다`() {
        val localId = UUID.randomUUID()
        val teamId = UUID.randomUUID()
        fun plugin(value: String) = object : FlowTransform {
            override fun id() = "same-id"
            override fun label() = value
            override fun apply(inputs: Map<String, String>, config: Map<String, String>) = mapOf("result" to value)
        }
        val personal = plugin("개인")
        val team = plugin("팀")
        val public = plugin("공용")
        val loader = ScriptPluginLoader { listOf(
            ScopedPlugin("owner", localId.toString(), personal),
            ScopedPlugin("owner", teamId.toString(), team),
            ScopedPlugin("owner", "public", public),
        ) }
        val localScope = object : TransformScope {
            override fun key(id: UUID?) = (id ?: localId).toString()
        }
        val localRegistry = TransformRegistry(PluginsProperties("build/tmp/none", false), loader, localScope)
        assertThat(localRegistry.get("same-id", tenantId = "owner").orElse(null)).isSameAs(personal)
        assertThat(localRegistry.get("same-id", teamId, "owner").orElse(null)).isSameAs(team)
        assertThat(localRegistry.get("same-id", tenantId = "another-owner")).isEmpty
        val serverRegistry = TransformRegistry(PluginsProperties("build/tmp/none", false), loader)
        assertThat(serverRegistry.get("same-id", tenantId = "owner").orElse(null)).isSameAs(public)
    }
}

/** test classpath에 존재하는 provider — 다른 테스트들에서 사용할 수 있다. */
class JarProbe : FlowTransform {
    override fun id() = "jar-probe"
    override fun label() = "jar-probe"
    override fun apply(inputs: Map<String, String>, config: Map<String, String>) = mapOf("result" to "ok")
}
