package com.flowlink.secret

import org.springframework.http.HttpStatus
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController

/**
 * 시크릿 볼트 API — write-only. GET 은 이름만(값 조회 불가), PUT 로 설정, DELETE 로 제거.
 * RBAC: GET=viewer, 쓰기=editor(OIDC URL 규칙) + **승인 사용자**(github/dev 모드 서비스 게이트 —
 * 게스트/승인 대기 계정이 팀 시크릿을 덮어쓰거나 지우던 구멍 봉인). 값은 실행 시 `{{ 이름@secret }}` 로만 쓰인다.
 */
@RestController
@RequestMapping("/api/v1/secrets")
class SecretController(
    private val service: SecretService,
    private val workspace: com.flowlink.workspace.WorkspaceService,
) {

    data class PutSecretRequest(val value: String, val environment: String? = null)

    private fun requireApproved() {
        if (!workspace.isApproved(workspace.currentUsername())) {
            throw com.flowlink.common.error.ForbiddenException("시크릿 변경은 가입 승인 후 가능합니다.")
        }
    }

    @GetMapping
    fun list(): List<SecretService.SecretView> = service.listNames()

    @PutMapping("/{name}")
    fun put(@PathVariable name: String, @RequestBody req: PutSecretRequest): SecretService.SecretView {
        requireApproved()
        service.put(name, req.value, req.environment)
        val env = req.environment?.trim().takeUnless { it.isNullOrEmpty() }
        return service.listNames().first { it.name == name.trim() && it.environment == env }
    }

    @DeleteMapping("/{name}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun delete(@PathVariable name: String, @RequestParam(required = false) environment: String?) {
        requireApproved()
        service.delete(name, environment)
    }
}
