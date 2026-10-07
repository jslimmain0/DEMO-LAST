package com.flowlink.desktop

import com.fasterxml.jackson.databind.ObjectMapper
import org.springframework.core.env.Environment
import java.awt.Desktop
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.nio.file.Path
import java.time.Duration

/** 이미 실행 중이면 기존 런타임이 발급한 일회용 접속 URL만 열고 끝낸다. */
object DesktopLaunch {
    /** MSI와 직접 JAR 실행 모두 개인 경계를 강제한다. jpackage 기본 인자나 외부 환경에 의존하지 않는다. */
    fun normalizeArguments(
        args: Array<String>,
        defaultPort: String = System.getProperty("flowlink.desktop.port", "18180"),
    ): Array<String> {
        val normalized = mutableListOf<String>()
        var index = 0
        while (index < args.size) {
            val arg = args[index++]
            if (arg.startsWith("--spring.profiles.")) {
                if (!arg.contains('=') && index < args.size && !args[index].startsWith("--")) index++
                continue
            }
            normalized += arg
        }
        normalized += "--spring.profiles.active=local,desktop"
        normalized += "--spring.profiles.include="
        if (normalized.none { it == "--server.port" || it.startsWith("--server.port=") })
            normalized += "--server.port=$defaultPort"
        return normalized.toTypedArray()
    }

    /** 운영용 환경변수가 개인 저장소·인증·바인딩을 덮어쓰면 DB 연결 전에 중단한다. */
    fun validate(env: Environment) {
        val directory = Path.of(env.getRequiredProperty("flowlink.desktop.data-dir")).toAbsolutePath().normalize()
        require(Files.exists(directory.resolve("storage.key")) || !Files.exists(directory.resolve("db/flowlink.mv.db"))) {
            "개인 DB가 있지만 암호화 키가 없습니다. DB와 storage.key를 같은 백업에서 복원하세요."
        }
        val jdbc = env.getRequiredProperty("spring.datasource.url")
        require(jdbc.startsWith("jdbc:h2:file:") &&
            Path.of(jdbc.removePrefix("jdbc:h2:file:").substringBefore(';')).toAbsolutePath().normalize() == directory.resolve("db/flowlink")) {
            "개인 에이전트는 개인 저장소의 H2 DB를 사용해야 합니다. 서버용 DB 환경변수를 제거하세요."
        }
        require(env.getProperty("server.address") == "127.0.0.1" && env.getProperty("server.servlet.context-path", "").isEmpty()) {
            "개인 에이전트의 주소는 127.0.0.1, 경로 접두사는 비워야 합니다."
        }
        require(!env.getProperty("flowlink.auth.github-enabled", Boolean::class.java, false) &&
            !env.getProperty("flowlink.vault.enabled", Boolean::class.java, false) &&
            !env.getProperty("flowlink.vault.transit.enabled", Boolean::class.java, false)) {
            "개인 에이전트는 로컬 인증·개인 암호화 키를 사용합니다. 서버용 인증/Vault 환경변수를 제거하세요."
        }
    }

    fun openExisting(args: Array<String>): Boolean {
        val directory = args.firstOrNull { it.startsWith("--flowlink.desktop.data-dir=") }?.substringAfter('=')
            ?: System.getenv("FLOWLINK_AGENT_DATA_DIR")
            ?: ((System.getenv("LOCALAPPDATA") ?: (System.getProperty("user.home") + "/.local/share")) + "/FlowLink")
        val file = Path.of(directory, "agent.json")
        if (!Files.exists(file)) return false
        val url = runCatching {
            val mapper = ObjectMapper()
            val agent = mapper.readTree(Files.readString(file))
            val base = URI.create(agent.path("baseUrl").asText())
            require(base.scheme == "http" && base.host == "127.0.0.1" && base.userInfo == null)
            val request = HttpRequest.newBuilder(base.resolve("/desktop/ticket")).timeout(Duration.ofSeconds(2))
                .header("X-FlowLink-Local", agent.path("token").asText()).POST(HttpRequest.BodyPublishers.noBody()).build()
            val response = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(1)).build().send(request, HttpResponse.BodyHandlers.ofString())
            if (response.statusCode() != 200) return false
            validateWorkspaceUrl(base, mapper.readTree(response.body()).path("url").asText())
        }.getOrNull() ?: return false
        if (!args.contains("--flowlink.desktop.tray=false") && !args.contains("--flowlink.desktop.open-browser=false")) {
            Desktop.getDesktop().browse(URI.create(url))
        }
        return true
    }

    /** 기존 프로세스의 응답도 그 개인 런타임의 접속 URL만 허용한다. */
    fun validateWorkspaceUrl(base: URI, value: String): String {
        val target = URI.create(value)
        require(target.scheme == "http" && target.host == "127.0.0.1" && target.port == base.port &&
            target.userInfo == null && target.fragment == null && target.path == "/desktop/open" &&
            Regex("(?:runtime=(?:local|server)&)?ticket=[A-Za-z0-9_-]{43}").matches(target.rawQuery.orEmpty())) {
            "작업 화면 주소가 개인 앱의 주소와 일치하지 않습니다."
        }
        return target.toString()
    }
}
