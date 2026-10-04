package com.flowlink.desktop

import com.fasterxml.jackson.core.type.TypeReference
import com.fasterxml.jackson.databind.ObjectMapper
import com.flowlink.common.error.BadRequestException
import com.flowlink.settings.SettingsService
import org.springframework.context.annotation.Profile
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.*
import java.security.MessageDigest
import java.util.UUID

/** 실행하는 사람의 환경 선택만 개인 H2에 보관한다. 주소/시크릿/공유 그래프는 저장하지 않는다. */
@RestController
@Profile("desktop")
@RequestMapping("/api/v1/desktop/environment-bindings")
class DesktopEnvironmentBindings(
    private val settings: SettingsService,
    private val connection: DesktopConnection,
    private val mapper: ObjectMapper,
) {
    data class View(val bindings: Map<String, String>, val revision: String)
    data class Save(
        val origin: String,
        val workspaceId: String,
        val environment: String? = null,
        val bindings: Map<String, String>,
        val revision: String,
    )
    class Conflict(message: String) : RuntimeException(message)
    private val type = object : TypeReference<Map<String, String>>() {}

    @GetMapping
    fun get(
        @RequestParam origin: String,
        @RequestParam workspaceId: String,
        @RequestParam(required = false) environment: String?,
        @RequestHeader("X-FlowLink-Server", required = false) server: String?,
        @RequestHeader("X-FlowLink-Account", required = false) account: String?,
    ): View = current(key(origin, workspaceId, environment, server, account))

    // 한 PC의 여러 브라우저가 오래된 설정으로 서로를 덮어쓰지 않는다.
    @PutMapping
    @Synchronized
    fun put(
        @RequestBody body: Save,
        @RequestHeader("X-FlowLink-Server", required = false) server: String?,
        @RequestHeader("X-FlowLink-Account", required = false) account: String?,
    ): View {
        val key = key(body.origin, body.workspaceId, body.environment, server, account)
        if (current(key).revision != body.revision)
            throw Conflict("다른 화면에서 환경 연결을 변경했습니다. 다시 불러온 뒤 선택을 확인하세요.")
        if (body.bindings.size > 200) throw BadRequestException("환경 연결은 200개 이하로 지정하세요.")
        val bindings = body.bindings.toSortedMap().mapValues { (target, name) ->
            if (target != "local" && !(target.startsWith("server:") && validWorkspace(target.removePrefix("server:"), false)))
                throw BadRequestException("환경 연결의 실행 위치 또는 공간이 올바르지 않습니다.")
            environment(name)
        }
        // 값이 빈 문자열인 항목은 사용자가 명시한 공통 환경이다. 삭제하지 않는다.
        settings.put(key, mapper.writeValueAsString(bindings))
        return current(key)
    }

    @ExceptionHandler(Conflict::class)
    fun conflict(error: Conflict): ResponseEntity<Map<String, String>> =
        ResponseEntity.status(409).body(mapOf("message" to error.message.orEmpty()))

    private fun key(origin: String, workspaceId: String, env: String?, server: String?, account: String?): String {
        if (origin !in setOf("local", "server") || !validWorkspace(workspaceId, origin == "local"))
            throw BadRequestException("환경 연결을 저장할 공간이 올바르지 않습니다.")
        val active = connection.view()
        if (server != active.serverUrl || account != active.login.orEmpty())
            throw Conflict("서버 또는 계정이 변경되었습니다. 환경 연결을 다시 불러오세요.")
        if (origin == "server" && !active.connected)
            throw BadRequestException("서버 공간의 환경 연결은 로그인 후 설정하세요.")
        // 같은 이름의 환경도 다른 공간/서버/계정의 환경과 자동 연결하지 않는다.
        val identity = listOf(origin, workspaceId, environment(env.orEmpty()), active.serverUrl, active.login.orEmpty())
        return "agent-environments:" + sha(mapper.writeValueAsString(identity))
    }

    private fun current(key: String): View {
        val raw = settings.get(key) ?: return View(emptyMap(), "")
        val bindings = try { mapper.readValue(raw, type) }
            catch (_: Exception) { throw BadRequestException("저장된 환경 연결을 읽지 못했습니다. 설정을 확인하세요.") }
        return View(bindings, sha(raw))
    }

    private fun environment(name: String): String = name.trim().also {
        if (it.length > 120 || it.any(Char::isISOControl)) throw BadRequestException("환경 이름이 올바르지 않습니다.")
    }

    private fun validWorkspace(value: String, local: Boolean): Boolean =
        value == (if (local) "local" else "public") || runCatching { UUID.fromString(value).toString() == value }.getOrDefault(false)

    private fun sha(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
}
