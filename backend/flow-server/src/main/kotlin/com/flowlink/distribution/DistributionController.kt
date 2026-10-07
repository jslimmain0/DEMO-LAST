package com.flowlink.distribution

import com.fasterxml.jackson.databind.ObjectMapper
import com.flowlink.common.release.ReleaseVersion
import jakarta.servlet.http.HttpServletRequest
import org.springframework.beans.factory.annotation.Value
import org.springframework.context.annotation.Profile
import org.springframework.core.io.FileSystemResource
import org.springframework.core.io.ClassPathResource
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.RestController
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Path
import java.nio.file.attribute.BasicFileAttributes
import java.security.MessageDigest

data class ReleaseManifest(
    val schemaVersion: Int,
    val version: String,
    val platform: String,
    val arch: String,
    val downloadPath: String,
    val size: Long,
    val sha256: String,
    val releaseNotes: String = "",
    val compatibleServerVersions: List<String>,
)

/** 공개 정보만 제공한다. SHA-256은 파일 일치 확인이며 발행자 서명 검증을 대신하지 않는다. */
@RestController
@Profile("!desktop")
class DistributionController(
    @Value("\${flowlink.distribution.dir:./downloads}") private val directory: String,
    @Value("\${FLOWLINK_PUBLIC_URL:}") private val publicUrl: String,
    @Value("\${FLOWLINK_PUBLIC_MCP_URL:}") private val mcpUrl: String,
    private val mapper: ObjectMapper,
) {
    private data class Fingerprint(val size: Long, val modified: java.nio.file.attribute.FileTime, val key: String?)
    private data class Validated(val release: ReleaseManifest, val manifest: Fingerprint, val artifact: Fingerprint)
    private data class Inspection(val status: String, val message: String, val release: ReleaseManifest? = null)
    private var cached: Validated? = null
    private val root get() = Path.of(directory).toAbsolutePath().normalize()

    /** 중앙 서버는 설치 안내만 제공하며 Windows 작업 화면으로 fallback하지 않는다. */
    @GetMapping("/", "/download", "/download/")
    fun page(req: HttpServletRequest): ResponseEntity<String> {
        val html = ClassPathResource("static/download.html").inputStream.use { it.readBytes().toString(Charsets.UTF_8) }
        val base = (req.contextPath.trimEnd('/') + "/").replace("&", "&amp;").replace("\"", "&quot;").replace("<", "&lt;").replace(">", "&gt;")
        return ResponseEntity.ok().contentType(MediaType.TEXT_HTML).header("Cache-Control", "no-store")
            .body(html.replace("<base href=\"/\">", "<base href=\"$base\">"))
    }

    @GetMapping("/api/v1/distribution")
    fun metadata(req: HttpServletRequest): ResponseEntity<Map<String, Any?>> {
        val base = publicUrl.trimEnd('/').ifBlank { "${req.scheme}://${req.serverName}:${req.serverPort}${req.contextPath}" }
        val mcp = mcpUrl.trim().ifBlank { "$base/mcp" }
        val inspected = inspect()
        val release = inspected.release
        return ResponseEntity.ok().header("Cache-Control", "no-store").body(mapOf(
            "serverUrl" to base, "mcpUrl" to mcp, "serverVersion" to ReleaseVersion.version,
            "nativeWindows" to true, "version" to release?.version,
            "installerUrl" to release?.let { base + it.downloadPath }, "available" to (release != null),
            "automaticUpdateAllowed" to (inspected.status == "AVAILABLE"),
            "releaseStatus" to inspected.status, "releaseMessage" to inspected.message, "release" to release,
        ))
    }

    /** 기존 다운로드 링크도 manifest가 확인된 현재 배포 파일을 가리킨다. */
    @GetMapping("/downloads/FlowLink.msi")
    fun download(): ResponseEntity<FileSystemResource> {
        val release = inspect().release ?: return ResponseEntity.notFound().header("Cache-Control", "no-store").build()
        return respond(root.resolve(release.downloadPath.substringAfterLast('/')))
    }

    @GetMapping("/downloads/{fileName}")
    fun downloadVersion(@PathVariable fileName: String): ResponseEntity<FileSystemResource> {
        val version = Regex("FlowLink-(.+)-windows-x64\\.msi").matchEntire(fileName)?.groupValues?.get(1)
        if (version == null || !ReleaseVersion.isValid(version)) return ResponseEntity.notFound().build()
        // 이전 manifest를 이미 받은 클라이언트도 게시 교체 뒤 동일한 불변 파일을 받을 수 있다.
        // 클라이언트는 해당 manifest의 size/hash를 다시 검증하며, 파일명은 버전 외 임의 지정할 수 없다.
        return respond(root.resolve(fileName))
    }

    private fun respond(file: Path): ResponseEntity<FileSystemResource> {
        val attributes = fingerprint(file) ?: return ResponseEntity.notFound().header("Cache-Control", "no-store").build()
        return ResponseEntity.ok().header("Content-Type", "application/octet-stream")
            .header("Content-Disposition", "attachment; filename=${file.fileName}")
            .header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff")
            .contentLength(attributes.size).body(FileSystemResource(file))
    }

    @Synchronized private fun inspect(): Inspection {
        val manifest = root.resolve("release-manifest.json")
        if (!Files.exists(manifest, NOFOLLOW_LINKS)) return Inspection("MISSING", "배포 manifest가 없습니다. 서버 관리자가 설치파일과 manifest를 함께 게시해야 합니다.")
        return try {
            val manifestStamp = fingerprint(manifest) ?: error("manifest file")
            require(manifestStamp.size in 1..65536) { "manifest size" }
            val old = cached
            val release = if (old != null && old.manifest == manifestStamp &&
                old.artifact == fingerprint(root.resolve(old.release.downloadPath.substringAfterLast('/')))) old.release
            else {
                val bytes = Files.newInputStream(manifest).use { it.readNBytes(65537) }
                require(bytes.size <= 65536) { "manifest size" }
                val node = mapper.readTree(bytes)
                require(node.path("schemaVersion").isIntegralNumber && node.path("schemaVersion").asInt() == 1)
                require(node.path("size").isIntegralNumber && node.path("size").canConvertToLong())
                for (field in listOf("version", "platform", "arch", "downloadPath", "sha256")) require(node.path(field).isTextual)
                require(node.path("compatibleServerVersions").isArray && node.path("compatibleServerVersions").all { it.isTextual })
                val value = mapper.treeToValue(node, ReleaseManifest::class.java)
                validate(value)
                val artifact = root.resolve(value.downloadPath.substringAfterLast('/'))
                val before = fingerprint(artifact) ?: error("installer file")
                require(before.size == value.size)
                val digest = MessageDigest.getInstance("SHA-256")
                Files.newInputStream(artifact).use { input ->
                    val buffer = ByteArray(64 * 1024)
                    var total = 0L
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        total += count
                        require(total <= value.size)
                        digest.update(buffer, 0, count)
                    }
                }
                require(digest.digest().joinToString("") { "%02x".format(it) }.equals(value.sha256, ignoreCase = true))
                require(before == fingerprint(artifact) && manifestStamp == fingerprint(manifest))
                cached = Validated(value, manifestStamp, before)
                value
            }
            if (ReleaseVersion.version !in release.compatibleServerVersions)
                Inspection("INCOMPATIBLE", "현재 서버 ${ReleaseVersion.version}와 호환 확인된 설치파일이 아닙니다. 자동 업데이트를 사용할 수 없습니다.", release)
            else Inspection("AVAILABLE", "설치파일의 크기와 SHA-256이 배포 manifest와 일치합니다.", release)
        } catch (_: Exception) {
            cached = null
            Inspection("INVALID", "배포 manifest 또는 설치파일이 없거나 검증에 실패했습니다. 서버 관리자에게 배포 파일 확인을 요청하세요.")
        }
    }

    private fun validate(value: ReleaseManifest) {
        require(value.schemaVersion == 1 && ReleaseVersion.isValid(value.version))
        require(value.platform == "windows" && value.arch == "x64")
        require(value.downloadPath == "/downloads/FlowLink-${value.version}-windows-x64.msi")
        require(value.size in 1..(1024L * 1024 * 1024))
        require(Regex("[0-9a-fA-F]{64}").matches(value.sha256))
        require(value.releaseNotes.length <= 16000)
        require(value.compatibleServerVersions.isNotEmpty() && value.compatibleServerVersions.size <= 100 && value.compatibleServerVersions.all(ReleaseVersion::isValid))
    }

    private fun fingerprint(file: Path): Fingerprint? = runCatching {
        Files.readAttributes(file, BasicFileAttributes::class.java, NOFOLLOW_LINKS).takeIf { it.isRegularFile }
            ?.let { Fingerprint(it.size(), it.lastModifiedTime(), it.fileKey()?.toString()) }
    }.getOrNull()
}
