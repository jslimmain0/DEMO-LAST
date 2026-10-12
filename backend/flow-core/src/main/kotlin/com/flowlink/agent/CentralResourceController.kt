package com.flowlink.agent

import com.flowlink.common.error.BadRequestException
import com.flowlink.common.error.ForbiddenException
import com.flowlink.environment.EnvironmentService
import com.flowlink.secret.SecretService
import com.flowlink.workspace.WorkspaceService
import org.springframework.http.CacheControl
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.*

/** 평문은 브라우저 목록 API가 아니라 인증된 PC 실행기의 필요한 참조에만 반환한다. */
@RestController
@RequestMapping("/api/v1/agent/resources")
class CentralResourceController(
    private val workspace: WorkspaceService,
    private val environments: EnvironmentService,
    private val secrets: SecretService,
) {
    data class Request(val environment: String? = null, val variables: Boolean = false, val secretNames: Set<String> = emptySet())
    data class Values(val vars: Map<String, String>, val secrets: Map<String, String>)

    @PostMapping
    fun resolve(@RequestBody body: Request, @RequestHeader("X-FlowLink-Device", required = false) device: String?): ResponseEntity<Values> {
        if (workspace.localRuntime || !workspace.isApproved(workspace.currentUsername()))
            throw ForbiddenException("중앙 자원은 가입 승인된 서버 계정으로 사용하세요.")
        workspace.requireWrite(workspace.currentUsername(), null)
        if (device.isNullOrBlank() || device.length > 100) throw BadRequestException("PC 실행기 식별자가 필요합니다.")
        if (body.secretNames.size > 200 || body.secretNames.any { it.isBlank() || it.length > 120 })
            throw BadRequestException("시크릿 참조가 올바르지 않습니다.")
        if (!environments.exists(body.environment, null)) throw BadRequestException("서버에 선택한 환경이 없습니다: ${body.environment}")
        val values = if (body.secretNames.isEmpty()) emptyMap() else secrets.activeSecrets(body.environment, null).filterKeys { it in body.secretNames }
        if (!values.keys.containsAll(body.secretNames)) throw BadRequestException("서버 시크릿 참조를 확인하세요.")
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
            .body(Values(if (body.variables) environments.vars(body.environment, null) else emptyMap(), values))
    }
}
