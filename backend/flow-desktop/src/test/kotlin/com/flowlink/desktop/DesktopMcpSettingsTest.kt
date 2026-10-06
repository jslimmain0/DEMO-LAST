package com.flowlink.desktop

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import org.assertj.core.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path

class DesktopMcpSettingsTest {
    @TempDir lateinit var directory: Path
    private val mapper = jacksonObjectMapper()
    private val settings = DesktopMcpSettings(mapper)

    @Test fun `IDE별 형식을 병합하고 소유한 항목만 갱신하고 제거한다`() {
        listOf("vscode", "intellij").forEach { client ->
            val path = directory.resolve("$client.json")
            Files.writeString(path, """{"inputs":[],"servers":{"other":{"url":"https://other.example"},"flowlink":{"url":"https://manual.example"}}}""")
            val target = DesktopMcpSettings.Target(client, client, path)
            var record = settings.apply(target, settings.entry(client, "https://company.example/mcp", "test-mcp-one"), null, "device-id") { }
            assertThat(record.key).isEqualTo("flowlink-desktop-device-i")
            var root = mapper.readTree(Files.readString(path))
            assertThat(root.path("servers").path("flowlink").path("url").asText()).isEqualTo("https://manual.example")
            val entry = root.path("servers").path(record.key)
            val headers = if (client == "vscode") entry.path("headers") else entry.path("requestInit").path("headers")
            assertThat(headers.path("Authorization").asText()).isEqualTo("Bearer test-mcp-one")
            record = settings.apply(target, settings.entry(client, "https://company.example/mcp", "test-mcp-two"), record, "device-id") { }
            assertThat(settings.remove(record)).isTrue()
            root = mapper.readTree(Files.readString(path))
            assertThat(root.path("servers").has(record.key)).isFalse()
            assertThat(root.path("servers").size()).isEqualTo(2)
            assertThat(root.has("inputs")).isTrue()
        }
    }

    @Test fun `수동편집 잘못된JSON 동시변경은 덮어쓰지 않는다`() {
        val path = directory.resolve("mcp.json")
        val target = DesktopMcpSettings.Target("vscode", "VS Code", path)
        val entry = settings.entry("vscode", "https://company.example/mcp", "test-mcp")
        val record = settings.apply(target, entry, null, "device") { }
        Files.writeString(path, """{"servers":{"flowlink":{"url":"https://edited.example"}}}""")
        assertThat(settings.remove(record)).isFalse()
        assertThatThrownBy { settings.apply(target, entry, record, "device") { } }.hasMessageContaining("보존")
        Files.writeString(path, "{broken")
        assertThatThrownBy { settings.apply(target, entry, null, "device") { } }.isInstanceOf(Exception::class.java)
        assertThat(Files.readString(path)).isEqualTo("{broken")
        Files.writeString(path, "{}")
        assertThatThrownBy { settings.apply(target, entry, null, "device") { Files.writeString(path, """{"inputs":[]}""") } }
            .hasMessageContaining("변경")
        assertThat(Files.readString(path)).isEqualTo("""{"inputs":[]}""")
    }

    @Test fun `JSONC를 읽고 존재하는 IDE 사용자 경로만 발견한다`() {
        val roaming = directory.resolve("roaming")
        val local = directory.resolve("local")
        Files.createDirectories(roaming.resolve("Code/User/profiles/one"))
        Files.createDirectories(local.resolve("github-copilot/intellij"))
        val targets = DesktopMcpSettings.discover(roaming, local)
        assertThat(targets.map { it.clientId }).containsExactly("vscode", "vscode", "intellij")
        val target = targets.first()
        Files.writeString(target.path, """{/* existing */ "servers":{"other":{"url":"https://other.example",},},}""")
        settings.apply(target, settings.entry("vscode", "https://company.example/mcp", "test-mcp"), null, "device") { }
        assertThat(mapper.readTree(Files.readString(target.path)).path("servers").has("other")).isTrue()
    }
}
