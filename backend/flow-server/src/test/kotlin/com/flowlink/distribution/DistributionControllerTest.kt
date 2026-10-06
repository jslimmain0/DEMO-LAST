package com.flowlink.distribution

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.flowlink.common.release.ReleaseVersion
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.springframework.mock.web.MockHttpServletRequest
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.*
import org.springframework.test.web.servlet.setup.MockMvcBuilders
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.FileTime
import java.security.MessageDigest

class DistributionControllerTest {
    @TempDir lateinit var directory: Path
    private val mapper = jacksonObjectMapper()
    private fun controller() = DistributionController(directory.toString(), "https://flowlink.example/app", "https://flowlink.example/mcp", mapper)
    private fun metadata(controller: DistributionController = controller()) = controller.metadata(MockHttpServletRequest()).body!!
    private fun publish(version: String = "2.3.4", compatible: List<String> = listOf(ReleaseVersion.version)): ReleaseManifest {
        val bytes = "isolated installer fixture $version".toByteArray()
        val release = ReleaseManifest(1, version, "windows", "x64", "/downloads/FlowLink-$version-windows-x64.msi", bytes.size.toLong(),
            MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }, "개선 안내", compatible)
        Files.write(directory.resolve(release.downloadPath.substringAfterLast('/')), bytes)
        writeManifest(release)
        return release
    }
    private fun writeManifest(value: Any) = Files.writeString(directory.resolve("release-manifest.json"), mapper.writeValueAsString(value))

    @Test fun `MCP 기본 주소는 공개 서버의 포트와 context 경로를 유지한다`() {
        val configured = DistributionController(directory.toString(), "https://flowlink.example/app/", "", mapper)
        assertThat(metadata(configured)["mcpUrl"]).isEqualTo("https://flowlink.example/app/mcp")
        val request = MockHttpServletRequest().apply { scheme = "http"; serverName = "localhost"; serverPort = 18080; contextPath = "/flowlink" }
        val inferred = DistributionController(directory.toString(), "", "", mapper)
        assertThat(inferred.metadata(request).body!!["mcpUrl"]).isEqualTo("http://localhost:18080/flowlink/mcp")
    }

    @Test fun `구 설치파일만 있는 서버를 최신 또는 검증된 배포로 표시하지 않는다`() {
        Files.writeString(directory.resolve("FlowLink.msi"), "legacy installer")
        val controller = controller()
        assertThat(metadata(controller)).containsEntry("releaseStatus", "MISSING").containsEntry("available", false)
            .containsEntry("automaticUpdateAllowed", false).containsEntry("version", null).containsEntry("release", null)
        assertThat(controller.download().statusCode.value()).isEqualTo(404)
    }

    @Test fun `manifest와 파일이 일치할 때만 배포 버전과 고정 경로를 공개한다`() {
        assertThat(ReleaseVersion.isValid(ReleaseVersion.version)).describedAs("VERSION 빌드 리소스가 필요합니다").isTrue()
        val release = publish()
        val controller = controller()
        assertThat(metadata(controller)).containsEntry("releaseStatus", "AVAILABLE").containsEntry("available", true)
            .containsEntry("automaticUpdateAllowed", true).containsEntry("version", release.version)
            .containsEntry("serverVersion", ReleaseVersion.version)
            .containsEntry("installerUrl", "https://flowlink.example/app${release.downloadPath}")
        val mockMvc = MockMvcBuilders.standaloneSetup(controller).build()
        mockMvc.perform(get("/api/v1/distribution")).andExpect(status().isOk)
            .andExpect(header().string("Cache-Control", "no-store"))
            .andExpect(jsonPath("$.release.sha256").value(release.sha256))
            .andExpect(jsonPath("$.serverUrl").value("https://flowlink.example/app"))
        for (path in listOf("/downloads/FlowLink.msi", release.downloadPath)) {
            mockMvc.perform(get(path)).andExpect(status().isOk)
                .andExpect(header().string("Content-Disposition", "attachment; filename=FlowLink-${release.version}-windows-x64.msi"))
                .andExpect(header().longValue("Content-Length", release.size))
                .andExpect(header().string("X-Content-Type-Options", "nosniff"))
                .andExpect(content().bytes(Files.readAllBytes(directory.resolve(release.downloadPath.substringAfterLast('/')))))
        }
    }

    @Test fun `호환 선언이 없는 서버에서는 수동 다운로드만 제공한다`() {
        publish(compatible = listOf("99.0.0"))
        val controller = controller()
        assertThat(metadata(controller)).containsEntry("releaseStatus", "INCOMPATIBLE").containsEntry("available", true)
            .containsEntry("automaticUpdateAllowed", false)
        assertThat(controller.download().statusCode.value()).isEqualTo(200)
    }

    @Test fun `파일 크기 해시 및 manifest 변경은 캐시를 무효화한다`() {
        val release = publish()
        val controller = controller()
        assertThat(metadata(controller)["releaseStatus"]).isEqualTo("AVAILABLE")
        val artifact = directory.resolve(release.downloadPath.substringAfterLast('/'))
        Files.writeString(artifact, "changed".padEnd(release.size.toInt(), '!'))
        Files.setLastModifiedTime(artifact, FileTime.fromMillis(System.currentTimeMillis() + 10_000))
        assertThat(metadata(controller)).containsEntry("releaseStatus", "INVALID").containsEntry("release", null)
        publish()
        assertThat(metadata(controller)["releaseStatus"]).isEqualTo("AVAILABLE")
        writeManifest(release.copy(size = release.size + 1))
        assertThat(metadata(controller)["releaseStatus"]).isEqualTo("INVALID")
        publish()
        assertThat(metadata(controller)["releaseStatus"]).isEqualTo("AVAILABLE")
        Files.delete(artifact)
        assertThat(metadata(controller)["releaseStatus"]).isEqualTo("INVALID")
    }

    @Test fun `임의 URL 경로 버전 아키텍처 및 미지원 스키마를 거부한다`() {
        val release = publish()
        val invalid = listOf(
            release.copy(downloadPath = "https://elsewhere.example/installer.msi"),
            release.copy(downloadPath = "/downloads/../private.msi"),
            release.copy(downloadPath = "//elsewhere.example/installer.msi"),
            release.copy(version = "2.3.4; command"), release.copy(version = "2.03.4"),
            release.copy(schemaVersion = 2), release.copy(arch = "arm64"), release.copy(platform = "linux"),
            release.copy(size = 0), release.copy(size = 1024L * 1024 * 1024 + 1),
            release.copy(sha256 = "broken"), release.copy(compatibleServerVersions = emptyList()),
        )
        val controller = controller()
        for (value in invalid) {
            writeManifest(value)
            assertThat(metadata(controller)).describedAs("invalid manifest: %s", value)
                .containsEntry("releaseStatus", "INVALID").containsEntry("automaticUpdateAllowed", false)
        }
        for (file in listOf("../FlowLink-2.3.4-windows-x64.msi", "private.enc", "FlowLink-2.3.4;cmd-windows-x64.msi"))
            assertThat(controller.downloadVersion(file).statusCode.value()).isEqualTo(404)
    }

    @Test fun `깨진 파일과 과대한 manifest는 자료나 내부 경로 없이 오류 상태를 반환한다`() {
        val manifest = directory.resolve("release-manifest.json")
        Files.writeString(manifest, "{broken")
        assertThat(metadata()).containsEntry("releaseStatus", "INVALID")
        Files.writeString(manifest, " ".repeat(65537))
        assertThat(metadata()).containsEntry("releaseStatus", "INVALID")
        assertThat(metadata().toString()).doesNotContain(directory.toString())
    }

    @Test fun `게시 중 최신 manifest가 바뀌어도 이전에 안내한 불변 파일을 받을 수 있다`() {
        val previous = publish("2.3.4")
        publish("2.3.5")
        val controller = controller()
        assertThat(metadata(controller)["version"]).isEqualTo("2.3.5")
        assertThat(controller.downloadVersion(previous.downloadPath.substringAfterLast('/')).statusCode.value()).isEqualTo(200)
    }
}
