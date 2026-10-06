package com.flowlink.desktop

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.junit.jupiter.api.assertThrows
import org.springframework.mock.env.MockEnvironment
import java.nio.file.Path

class DesktopLaunchTest {
    @TempDir lateinit var directory: Path

    @Test fun `직접 JAR 실행과 설치 앱의 추가 인자가 개인 프로파일과 기본 포트를 제거하지 못한다`() {
        for (input in listOf(emptyArray(), arrayOf("--flowlink.desktop.open-browser=false"))) {
            val actual = DesktopLaunch.normalizeArguments(input)
            assertThat(actual).contains("--spring.profiles.active=local,desktop", "--spring.profiles.include=", "--server.port=18180")
            assertThat(actual).containsAll(input.toList())
        }
        val override = arrayOf("--spring.profiles.active=oracle", "--spring.profiles.include=dev-auth",
            "--server.port=18182", "--flowlink.desktop.data-dir=C:/isolated-agent", "--flowlink.desktop.open-browser=false")
        val native = DesktopLaunch.normalizeArguments(override)
        assertThat(native).contains("--spring.profiles.active=local,desktop", "--server.port=18182",
            "--flowlink.desktop.data-dir=C:/isolated-agent", "--flowlink.desktop.open-browser=false")
        assertThat(native).doesNotContain("--spring.profiles.active=oracle", "--spring.profiles.include=dev-auth", "--server.port=18180")
        assertThat(DesktopLaunch.normalizeArguments(emptyArray(), "19080")).contains("--server.port=19080")
        val separated = DesktopLaunch.normalizeArguments(arrayOf("--spring.profiles.active", "dev", "--server.port=18182"))
        assertThat(separated).contains("--spring.profiles.active=local,desktop", "--server.port=18182").doesNotContain("dev")
    }

    @Test fun `서버용 DB와 인증 환경이 개인 에이전트에 섞이면 DB 연결 전에 거부한다`() {
        val env = MockEnvironment().withProperty("flowlink.desktop.data-dir", directory.toString())
            .withProperty("spring.datasource.url", "jdbc:h2:file:${directory.resolve("db/flowlink")};WRITE_DELAY=0")
            .withProperty("server.address", "127.0.0.1")
        DesktopLaunch.validate(env)
        env.setProperty("spring.datasource.url", "jdbc:oracle:thin:@server:1521/service")
        assertThrows<IllegalArgumentException> { DesktopLaunch.validate(env) }
        env.setProperty("spring.datasource.url", "jdbc:h2:file:${directory.resolve("db/flowlink")}")
        env.setProperty("flowlink.auth.github-enabled", "true")
        assertThrows<IllegalArgumentException> { DesktopLaunch.validate(env) }
        env.setProperty("flowlink.auth.github-enabled", "false")
        env.setProperty("server.address", "0.0.0.0")
        assertThrows<IllegalArgumentException> { DesktopLaunch.validate(env) }
        env.setProperty("server.address", "127.0.0.1")
        java.nio.file.Files.createDirectories(directory.resolve("db"))
        java.nio.file.Files.createFile(directory.resolve("db/flowlink.mv.db"))
        assertThrows<IllegalArgumentException> { DesktopLaunch.validate(env) }
    }
}
