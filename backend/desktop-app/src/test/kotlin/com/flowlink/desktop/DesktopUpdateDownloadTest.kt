package com.flowlink.desktop

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.flowlink.agent.AgentTaskRepository
import com.flowlink.common.lifecycle.RuntimeUpdateGate
import com.flowlink.common.release.ReleaseVersion
import com.flowlink.core.repository.ExecutionRepository
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.mockito.ArgumentMatchers.any
import org.mockito.Mockito.*
import org.springframework.context.ConfigurableApplicationContext
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest

/** 실제 앱/설치기를 실행하지 않고 HTTP 경계에서 확인→다운로드 상태 전이를 검증한다. */
class DesktopUpdateDownloadTest {
    @TempDir lateinit var directory: Path
    private val payload = "fixture installer bytes".toByteArray()
    private val mapper = jacksonObjectMapper()

    private fun metadata() = mapper.writeValueAsBytes(mapOf(
        "releaseStatus" to "AVAILABLE", "automaticUpdateAllowed" to true,
        "serverVersion" to ReleaseVersion.version,
        "release" to mapOf("schemaVersion" to 1, "version" to "99.0.0", "platform" to "windows", "arch" to "x64",
            "downloadPath" to "/downloads/FlowLink-99.0.0-windows-x64.msi", "size" to payload.size,
            "sha256" to MessageDigest.getInstance("SHA-256").digest(payload).joinToString("") { "%02x".format(it) },
            "compatibleServerVersions" to listOf(ReleaseVersion.version), "releaseNotes" to "테스트 릴리스")))

    @Suppress("UNCHECKED_CAST")
    private fun response(bytes: ByteArray, code: Int = 200): HttpResponse<InputStream> {
        val value = mock(HttpResponse::class.java) as HttpResponse<InputStream>
        `when`(value.statusCode()).thenReturn(code)
        `when`(value.body()).thenReturn(ByteArrayInputStream(bytes))
        return value
    }

    private fun withService(download: ByteArray, action: (DesktopUpdateService, DesktopConnection) -> Unit) {
        DesktopSession(directory.toString(), 18182).use { session ->
            val connection = mock(DesktopConnection::class.java)
            val http = mock(HttpClient::class.java)
            `when`(connection.serverUrl()).thenReturn("http://127.0.0.1:18080")
            `when`(connection.view()).thenAnswer { DesktopConnection.View(connection.serverUrl(), "", null, false) }
            `when`(connection.client).thenReturn(http)
            val metadataResponse = response(metadata())
            val downloadResponse = response(download)
            `when`(http.send(any(HttpRequest::class.java), org.mockito.ArgumentMatchers.any<HttpResponse.BodyHandler<InputStream>>()))
                .thenReturn(metadataResponse, downloadResponse)
            val service = DesktopUpdateService(session, connection, mapper, RuntimeUpdateGate(), mock(ExecutionRepository::class.java),
                mock(AgentTaskRepository::class.java), mock(DesktopDispatcher::class.java), mock(ConfigurableApplicationContext::class.java))
            try { action(service, connection) } finally { service.close() }
        }
    }

    private fun settled(service: DesktopUpdateService): DesktopUpdateService.View {
        val end = System.nanoTime() + 5_000_000_000L
        while (service.view().phase in listOf("checking", "downloading") && System.nanoTime() < end) Thread.sleep(10)
        return service.view()
    }

    @Test fun `verified download becomes ready and preserves exact bytes`() = withService(payload) { service, _ ->
        service.checkUpdate()
        assertEquals("available", settled(service).phase)
        service.download()
        assertEquals("ready", settled(service).phase)
        assertEquals(payload.size.toLong(), service.view().downloadedBytes)
        assertArrayEquals(payload, Files.readAllBytes(directory.resolve("updates/FlowLink-99.0.0-windows-x64.msi")))
    }

    @Test fun `truncated body never becomes installable and partial file is removed`() = withService(payload.copyOf(3)) { service, _ ->
        service.checkUpdate(); assertEquals("available", settled(service).phase)
        service.download(); assertEquals("error", settled(service).phase)
        assertFalse(Files.exists(directory.resolve("updates/FlowLink-99.0.0-windows-x64.msi")))
        Files.list(directory.resolve("updates")).use { assertEquals(0, it.count()) }
    }

    @Test fun `changing server after check prevents downloading the old release`() = withService(payload) { service, connection ->
        service.checkUpdate(); assertEquals("available", settled(service).phase)
        `when`(connection.serverUrl()).thenReturn("https://another.example")
        service.download(); assertEquals("error", settled(service).phase)
        assertFalse(Files.exists(directory.resolve("updates/FlowLink-99.0.0-windows-x64.msi")))
    }
}
