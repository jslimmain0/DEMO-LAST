package com.flowlink.desktop

import com.fasterxml.jackson.core.JsonParser
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ObjectNode
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.security.MessageDigest

/** IDE 사용자 설정만 병합한다. 프로젝트 파일이나 IDE 실행/등록 API를 호출하지 않는다. */
class DesktopMcpSettings(mapper: ObjectMapper) {
    private val json = mapper.copy().enable(JsonParser.Feature.ALLOW_COMMENTS)
        .enable(JsonParser.Feature.ALLOW_TRAILING_COMMA).enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION)

    data class Target(val clientId: String, val label: String, val path: Path)
    data class Managed(val path: String, val key: String, val hashes: Set<String>)

    fun entry(clientId: String, url: String, token: String): ObjectNode {
        require(clientId in setOf("vscode", "intellij"))
        require(token.isNotBlank() && token.length <= 16_384 && token.none { it.isWhitespace() })
        DesktopConnection.validateUrl(url)
        return json.createObjectNode().apply {
            put("url", url)
            if (clientId == "vscode") {
                put("type", "http")
                putObject("headers").put("Authorization", "Bearer $token")
            } else putObject("requestInit").putObject("headers").put("Authorization", "Bearer $token")
        }
    }

    fun apply(target: Target, value: ObjectNode, previous: Managed?, deviceId: String,
              prepared: (Managed) -> Unit): Managed {
        val original = read(target.path)
        val root = parse(original)
        val servers = servers(root)
        val key = previous?.key ?: if (!servers.has("flowlink")) "flowlink" else "flowlink-desktop-${deviceId.take(8)}"
        val existing = servers.get(key)
        if (existing != null && (previous == null || hash(existing) !in previous.hashes))
            error("FlowLink 항목을 사용자가 변경했습니다. 기존 설정을 보존했습니다.")
        val currentHash = existing?.let(::hash)
        val next = Managed(target.path.toString(), key, setOfNotNull(currentHash, hash(value)))
        // 먼저 두 상태를 기록한다. 파일 교체 직후 종료되어도 이전/새 토큰 항목을 소유자로 확인한다.
        prepared(next)
        if (existing != value) {
            servers.set<JsonNode>(key, value)
            write(target.path, original, root)
        }
        return next.copy(hashes = setOf(hash(value)))
    }

    fun remove(record: Managed): Boolean {
        val path = Path.of(record.path)
        val original = read(path)
        if (original == null) return true
        val root = parse(original)
        val servers = root.get("servers") as? ObjectNode ?: return true
        val existing = servers.get(record.key) ?: return true
        if (hash(existing) !in record.hashes) return false // 사용자가 편집한 항목은 지우지 않는다.
        servers.remove(record.key)
        write(path, original, root)
        return true
    }

    private fun hash(value: JsonNode): String = MessageDigest.getInstance("SHA-256")
        .digest(json.writeValueAsBytes(value)).joinToString("") { "%02x".format(it) }

    private fun safe(path: Path) {
        var part: Path? = path.toAbsolutePath()
        while (part != null) {
            require(!Files.isSymbolicLink(part)) { "링크로 연결된 IDE 설정은 자동 변경하지 않습니다." }
            part = part.parent
        }
        require(!Files.exists(path) || Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS))
    }

    private fun read(path: Path): ByteArray? {
        safe(path)
        if (!Files.exists(path)) return null
        require(Files.size(path) <= 1024 * 1024) { "IDE 설정 파일이 1MB를 초과했습니다." }
        return Files.readAllBytes(path)
    }

    private fun parse(bytes: ByteArray?): ObjectNode = if (bytes == null) json.createObjectNode()
        else json.readTree(bytes) as? ObjectNode ?: error("IDE 설정은 JSON 객체여야 합니다.")

    private fun servers(root: ObjectNode): ObjectNode = root.get("servers")?.let {
        it as? ObjectNode ?: error("IDE servers 설정은 JSON 객체여야 합니다.")
    } ?: root.putObject("servers")

    private fun write(path: Path, original: ByteArray?, root: ObjectNode) {
        safe(path)
        Files.createDirectories(path.parent)
        val temp = Files.createTempFile(path.parent, ".flowlink-", ".tmp")
        try {
            DesktopSession.protect(temp)
            Files.writeString(temp, json.writerWithDefaultPrettyPrinter().writeValueAsString(root) + "\n")
            // ponytail: 수동 편집기는 같은 잠금을 공유하지 않는다. 관찰된 동시 변경은 덮어쓰지 않는다.
            val latest = read(path)
            check(if (original == null) latest == null else latest != null && original.contentEquals(latest)) {
                "IDE 설정이 변경되었습니다. 다시 적용하세요."
            }
            Files.move(temp, path, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } finally { Files.deleteIfExists(temp) }
    }

    companion object {
        fun discover(roaming: Path?, local: Path?): List<Target> = buildList {
            listOf("Code", "Code - Insiders").forEach { editor ->
                val user = roaming?.resolve("$editor/User") ?: return@forEach
                if (Files.isDirectory(user)) {
                    add(Target("vscode", if (editor == "Code") "VS Code" else "VS Code Insiders", user.resolve("mcp.json")))
                    val profiles = user.resolve("profiles")
                    if (Files.isDirectory(profiles)) Files.list(profiles).use { paths ->
                        paths.filter { Files.isDirectory(it) }.sorted().limit(100).forEach {
                            add(Target("vscode", "$editor · ${it.fileName}", it.resolve("mcp.json")))
                        }
                    }
                }
            }
            val jetbrains = local?.resolve("github-copilot/intellij")
            if (jetbrains != null && Files.isDirectory(jetbrains)) add(Target("intellij", "IntelliJ · Copilot", jetbrains.resolve("mcp.json")))
        }
    }
}
