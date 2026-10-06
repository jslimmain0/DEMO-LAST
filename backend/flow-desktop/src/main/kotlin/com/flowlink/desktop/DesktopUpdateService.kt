package com.flowlink.desktop

import com.fasterxml.jackson.databind.ObjectMapper
import com.flowlink.agent.AgentTaskRepository
import com.flowlink.core.domain.ExecutionStatus
import com.flowlink.core.repository.ExecutionRepository
import com.flowlink.common.lifecycle.RuntimeUpdateGate
import jakarta.annotation.PreDestroy
import org.springframework.context.ConfigurableApplicationContext
import org.springframework.context.annotation.Profile
import org.springframework.stereotype.Service
import org.springframework.web.bind.annotation.*
import java.net.URI
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.time.Duration
import java.util.concurrent.Executors
import org.springframework.boot.context.event.ApplicationReadyEvent
import org.springframework.context.event.EventListener

@Service
@Profile("desktop")
class DesktopUpdateService(
    private val session: DesktopSession, private val connection: DesktopConnection,
    private val mapper: ObjectMapper, private val gate: RuntimeUpdateGate,
    private val executions: ExecutionRepository, private val tasks: AgentTaskRepository,
    private val dispatcher: DesktopDispatcher, private val context: ConfigurableApplicationContext,
) {
    data class View(val phase: String, val currentVersion: String, val availableVersion: String? = null,
        val downloadedBytes: Long = 0, val totalBytes: Long = 0, val message: String,
        val releaseNotes: String? = null)
    private val version = com.flowlink.common.release.ReleaseVersion.version
    @Volatile private var state = View("idle", version, message = "업데이트를 확인하세요.")
    private val worker = Executors.newSingleThreadScheduledExecutor { Thread(it, "desktop-update").apply { isDaemon = true } }
    private val watchdog = Executors.newSingleThreadScheduledExecutor { Thread(it, "desktop-update-timeout").apply { isDaemon = true } }
    private var release: com.fasterxml.jackson.databind.JsonNode? = null
    private var installer: Path? = null
    private var source = ""
    private var recoveredNotice = false
    @EventListener(ApplicationReadyEvent::class)
    fun ready() {
        recoverResult()
        worker.scheduleWithFixedDelay({
            if (recoveredNotice) { recoveredNotice = false; return@scheduleWithFixedDelay }
            if (connection.view().serverUrl.isBlank()) {
                if (state.phase == "idle") state = state.copy(message = "서버를 연결하면 앱 업데이트를 자동으로 확인합니다.")
            } else if (state.phase !in listOf("checking", "downloading", "installing", "ready", "available")) runCatching { checkUpdate() }
        }, 30, 21600, java.util.concurrent.TimeUnit.SECONDS)
    }
    private fun recoverResult() {
        val dir = session.directory.resolve("updates")
        if (!Files.isDirectory(dir)) return
        runCatching {
            Files.list(dir).use { paths ->
                val latest = paths.filter { Files.isDirectory(it) && it.fileName.toString().startsWith("install-") }
                    .sorted(java.util.Comparator.reverseOrder()).findFirst().orElse(null) ?: return
                val request = mapper.readTree(Files.readString(latest.resolve("request.json")))
                val result = mapper.readTree(Files.readString(latest.resolve("result.json")).removePrefix("\uFEFF"))
                val target = request.path("targetVersion").asText()
                val phase = result.path("phase").asText()
                val success = phase in listOf("installed", "reboot-required") && result.path("exitCode").asInt(-1) in listOf(0, 3010) && target == version
                recoveredNotice = true
                state = View(if (success) "current" else "error", version,
                    message = if (success) { if (phase == "reboot-required") "업데이트를 설치했습니다. Windows 재시작이 필요합니다." else "업데이트 설치를 확인했습니다." }
                    else "이전 업데이트를 완료하지 못했거나 설치 버전이 일치하지 않습니다. updates 폴더의 결과와 설치 로그를 확인하세요.")
            }
        }
    }
    @Synchronized fun view(): View {
        if (source.isNotBlank() && connection.view().serverUrl.trimEnd('/') != source && state.phase in listOf("available", "ready", "current")) {
            release = null; installer = null; source = ""
            state = View("error", version, message = "서버가 변경되었습니다. 업데이트를 다시 확인하세요.")
        }
        return state
    }
    private fun <T> body(response: HttpResponse<java.io.InputStream>, seconds: Long, action: (java.io.InputStream) -> T): T {
        val input = response.body()
        val timeout = watchdog.schedule({ runCatching { input.close() } }, seconds, java.util.concurrent.TimeUnit.SECONDS)
        return try { input.use(action) } finally { timeout.cancel(false) }
    }
    @Synchronized private fun submit(phase: String, action: () -> Unit): View {
        check(state.phase !in listOf("checking", "downloading", "installing")) { "업데이트 작업이 진행 중입니다." }
        state = state.copy(phase = phase, message = if (phase == "checking") "업데이트 확인 중…" else "설치 파일 다운로드 중…")
        worker.execute { try { action() } catch (_: Exception) { state = state.copy(phase = "error", message = "업데이트를 완료하지 못했습니다. 서버 연결과 저장 공간을 확인한 뒤 다시 시도하세요.") } }
        return state
    }
    fun checkUpdate() = submit("checking") {
        recoveredNotice = false
        release = null; installer = null; source = ""
        state = state.copy(availableVersion = null, downloadedBytes = 0, totalBytes = 0, releaseNotes = null)
        val base = connection.serverUrl().trimEnd('/')
        try { validateServer(base) } catch (_: IllegalArgumentException) {
            state = View("error", version, message = "자동 업데이트에는 HTTPS 서버 주소가 필요합니다. 서버 주소를 변경하거나 설치 파일을 수동으로 받으세요.")
            return@submit
        }
        val response = connection.client.send(HttpRequest.newBuilder(URI.create("$base/api/v1/distribution"))
            .timeout(Duration.ofSeconds(20)).GET().build(), HttpResponse.BodyHandlers.ofInputStream())
        val metadata = body(response, 20) { input -> check(response.statusCode() == 200); val bytes = input.readNBytes(65537); check(bytes.size <= 65536); mapper.readTree(bytes) }
        check(connection.serverUrl().trimEnd('/') == base) { "서버가 변경되었습니다." }
        val candidate = metadata.path("release")
        if (metadata.path("releaseStatus").asText() != "AVAILABLE" || !metadata.path("automaticUpdateAllowed").asBoolean(false) || candidate.isMissingNode || candidate.isNull) {
            release = null; installer = null
            state = View("error", version, message = "서버에서 호환되는 업데이트를 제공하지 않습니다.")
        } else {
            validateRelease(candidate)
            check(candidate.path("compatibleServerVersions").any { it.asText() == metadata.path("serverVersion").asText() })
            source = base; release = candidate; installer = null
            val comparison = compareVersions(candidate.path("version").asText(), version)
            val newer = comparison > 0
            state = View(if (newer) "available" else "current", version, candidate.path("version").asText(),
                totalBytes = candidate.path("size").asLong(), message = if (newer) "새 업데이트가 있습니다." else if (comparison < 0) "설치 버전이 서버 배포보다 새롭습니다. 다운그레이드하지 않습니다." else "현재 버전이 최신입니다.", releaseNotes = candidate.path("releaseNotes").asText())
        }
    }
    fun download() = submit("downloading") {
        val selected = checkNotNull(release); check(compareVersions(selected.path("version").asText(), version) > 0)
        check(connection.serverUrl().trimEnd('/') == source) { "서버가 변경되었습니다." }
        val dir = session.directory.resolve("updates").also { Files.createDirectories(it); DesktopSession.protect(it) }
        val target = dir.resolve("FlowLink-${selected.path("version").asText()}-windows-x64.msi")
        val partial = Files.createTempFile(dir, "download-", ".part")
        DesktopSession.protect(partial)
        try {
            val response = connection.client.send(HttpRequest.newBuilder(URI.create(source + selected.path("downloadPath").asText()))
                .timeout(Duration.ofMinutes(15)).GET().build(), HttpResponse.BodyHandlers.ofInputStream())
            body(response, 900) { input -> check(response.statusCode() == 200); Files.newOutputStream(partial).use { output ->
                val buffer = ByteArray(65536); var total = 0L
                while (true) { val count = input.read(buffer); if (count < 0) break; total += count; check(total <= selected.path("size").asLong()); output.write(buffer, 0, count); state = state.copy(downloadedBytes = total) }
            } }
            verify(partial, selected.path("size").asLong(), selected.path("sha256").asText())
            check(connection.serverUrl().trimEnd('/') == source) { "서버가 변경되었습니다." }
            Files.move(partial, target, java.nio.file.StandardCopyOption.REPLACE_EXISTING)
            installer = target; state = state.copy(phase = "ready", message = "파일 검증을 마쳤습니다. 설치하면 앱과 Mock 수신이 잠시 중단됩니다.")
        } finally { Files.deleteIfExists(partial) }
    }
    @Synchronized fun install() {
        check(state.phase == "ready") { "다운로드와 검증을 먼저 완료하세요." }
        val selected = checkNotNull(release); val file = checkNotNull(installer)
        check(connection.serverUrl().trimEnd('/') == source) { "서버가 변경되었습니다. 업데이트를 다시 확인하세요." }
        val bundle = Path.of(checkNotNull(System.getProperty("flowlink.bundle.dir")) { "설치된 Windows 앱에서 업데이트하세요." }).toAbsolutePath().normalize()
        val launcher = bundle.parent.resolve("FlowLink.exe")
        val helper = bundle.resolve("Apply-DesktopUpdate.ps1")
        check(Files.isRegularFile(launcher) && Files.isRegularFile(helper)) { "업데이트 실행 파일을 찾지 못했습니다." }
        verify(file, selected.path("size").asLong(), selected.path("sha256").asText())
        gate.freeze {
            check(executions.findByStatusIn(listOf(ExecutionStatus.RUNNING, ExecutionStatus.WAITING)).isEmpty()) { "진행 중인 실행 또는 대기를 마친 뒤 설치하세요." }
            check(tasks.findByStatusIn(listOf("PENDING", "RUNNING", "CLAIMED", "UNKNOWN")).isEmpty() && dispatcher.views().isEmpty()) { "에이전트 작업과 결과 확인을 마친 뒤 설치하세요." }
        }
        try {
            val dir = session.directory.resolve("updates").resolve("install-${System.currentTimeMillis()}").also { Files.createDirectories(it); DesktopSession.protect(it) }
            val request = dir.resolve("request.json")
            val start = ProcessHandle.current().info().startInstant().orElseThrow()
            Files.writeString(request, mapper.writeValueAsString(mapOf("processId" to ProcessHandle.current().pid(),
                "processStartTicks" to (start.epochSecond * 10_000_000L + start.nano / 100 + 621355968000000000L).toString(),
                "targetVersion" to selected.path("version").asText(), "launcher" to launcher.toString(), "installer" to file.toString(), "sha256" to selected.path("sha256").asText())))
            DesktopSession.protect(request)
            val process = ProcessBuilder("powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helper.toString(), "-RequestFile", request.toString())
                .redirectErrorStream(true).redirectOutput(dir.resolve("helper.log").toFile()).start()
            val deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(10)
            while (!Files.exists(dir.resolve("ready")) && process.isAlive && System.nanoTime() < deadline) Thread.sleep(50)
            check(Files.exists(dir.resolve("ready")) && process.isAlive) { "설치 보조 프로그램이 준비되지 않았습니다. 현재 앱을 유지합니다." }
            Files.writeString(dir.resolve("commit"), "install")
            state = state.copy(phase = "installing", message = "앱을 종료하고 업데이트합니다.")
            Thread { Thread.sleep(500); context.close() }.start()
        } catch (failure: Exception) { gate.resume(); throw failure }
    }
    @PreDestroy fun close() { worker.shutdownNow(); watchdog.shutdownNow() }
    companion object {
        fun compareVersions(left: String, right: String): Int {
            return com.flowlink.common.release.ReleaseVersion.compare(left, right)
        }
        fun validateServer(base: String) { val uri = URI.create(base); require(uri.userInfo == null && uri.query == null && uri.fragment == null && (uri.scheme == "https" || (uri.scheme == "http" && uri.host in listOf("localhost", "127.0.0.1", "::1")))) }
        fun validateRelease(value: com.fasterxml.jackson.databind.JsonNode) {
            require(value.path("schemaVersion").isIntegralNumber && value.path("schemaVersion").asInt() == 1 && value.path("platform").asText() == "windows" && value.path("arch").asText() == "x64")
            val version = value.path("version").asText(); compareVersions(version, version)
            require(value.path("downloadPath").asText() == "/downloads/FlowLink-$version-windows-x64.msi")
            require(value.path("size").isIntegralNumber && value.path("size").asLong() in 1..1_073_741_824L && Regex("[a-fA-F0-9]{64}").matches(value.path("sha256").asText()))
        }
        fun verify(path: Path, size: Long, expected: String) {
            require(Files.size(path) == size)
            val digest = MessageDigest.getInstance("SHA-256")
            Files.newInputStream(path).use { input -> val buffer = ByteArray(65536); while (true) { val count = input.read(buffer); if (count < 0) break; digest.update(buffer, 0, count) } }
            require(digest.digest().joinToString("") { "%02x".format(it) }.equals(expected, true))
        }
    }
}

@RestController
@Profile("desktop")
class DesktopUpdateController(private val updates: DesktopUpdateService, private val tray: DesktopTray) {
    @ExceptionHandler(IllegalStateException::class)
    fun invalid(error: IllegalStateException) = org.springframework.http.ResponseEntity.badRequest().body(mapOf("message" to (error.message ?: "업데이트 작업을 시작하지 못했습니다.")))
    @GetMapping("/api/v1/desktop/update") fun status() = updates.view()
    @PostMapping("/api/v1/desktop/update/check") fun check() = updates.checkUpdate()
    @PostMapping("/api/v1/desktop/update/download") fun download() = updates.download()
    @PostMapping("/api/v1/desktop/update/open-window") fun open(): Map<String, Boolean> { tray.updateDialog(); return mapOf("opened" to true) }
}
