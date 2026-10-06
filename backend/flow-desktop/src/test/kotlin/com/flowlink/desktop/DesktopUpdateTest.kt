package com.flowlink.desktop

import com.fasterxml.jackson.databind.ObjectMapper
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.junit.jupiter.api.assertThrows
import org.assertj.core.api.Assertions.assertThat
import java.nio.file.Files
import java.nio.file.Path

class DesktopUpdateTest {
    @TempDir lateinit var directory: Path
    @Test fun `교차 origin과 서버 외부의 임의 설치 경로를 거부한다`() {
        assertThrows<IllegalArgumentException> { DesktopUpdateService.validateServer("http://company.internal") }
        assertThrows<IllegalArgumentException> { DesktopUpdateService.validateServer("https://user:password@company.internal") }
        DesktopUpdateService.validateServer("http://127.0.0.1:18182")
        val manifest = ObjectMapper().readTree("""{"schemaVersion":1,"version":"0.3.4","platform":"windows","arch":"x64","downloadPath":"https://other.example/app.msi","size":10,"sha256":"${"a".repeat(64)}"}""")
        assertThrows<IllegalArgumentException> { DesktopUpdateService.validateRelease(manifest) }
        (manifest as com.fasterxml.jackson.databind.node.ObjectNode).put("downloadPath", "/downloads/FlowLink-0.3.4-windows-x64.msi")
        DesktopUpdateService.validateRelease(manifest)
    }
    @Test fun `다운로드 변조와 잘린 파일을 설치 전에 거부한다`() {
        val file = directory.resolve("update.msi"); Files.writeString(file, "hello")
        val hash = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        DesktopUpdateService.verify(file, 5, hash)
        assertThrows<IllegalArgumentException> { DesktopUpdateService.verify(file, 6, hash) }
        Files.writeString(file, "other")
        assertThrows<IllegalArgumentException> { DesktopUpdateService.verify(file, 5, hash) }
    }
    @Test fun `문자열순서 대신 숫자로 버전을 비교하고 미확인 버전은 설치하지 않는다`() {
        assertThat(DesktopUpdateService.compareVersions("0.3.10", "0.3.9")).isGreaterThan(0)
        assertThat(DesktopUpdateService.compareVersions("0.3.4", "0.3.4")).isZero()
        assertThrows<IllegalArgumentException> { DesktopUpdateService.compareVersions("0.3.4", "unknown") }
    }
}
