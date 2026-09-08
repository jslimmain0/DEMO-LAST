package com.flowlink.environment

import org.springframework.http.HttpStatus
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController
import java.util.UUID

/**
 * 실행 환경 API — `GET /environments`(목록+변수) · `PUT /environments/{name}`(생성/변수 교체) ·
 * `POST /environments/{name}/rename` · `DELETE /environments/{name}`. 쓰기=승인 사용자.
 * 실행 입력값: `GET/PUT /flows/{id}/run-input`(워크스페이스 롤 게이트).
 */
@RestController
@RequestMapping("/api/v1")
class EnvironmentController(private val service: EnvironmentService) {

    data class PutEnvRequest(val vars: Map<String, String>? = null)
    data class RenameRequest(val to: String? = null)
    data class RunInputRequest(val vars: Map<String, String>? = null)

    @GetMapping("/environments")
    fun list(): List<EnvironmentService.EnvView> = service.list()

    @PutMapping("/environments/{name}")
    fun put(@PathVariable name: String, @RequestBody(required = false) req: PutEnvRequest?): EnvironmentService.EnvView =
        service.put(name, req?.vars)

    @PostMapping("/environments/{name}/rename")
    fun rename(@PathVariable name: String, @RequestBody req: RenameRequest): EnvironmentService.EnvView =
        service.rename(name, req.to)

    @DeleteMapping("/environments/{name}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun delete(@PathVariable name: String) = service.delete(name)

    @GetMapping("/flows/{flowId}/run-input")
    fun runInput(@PathVariable flowId: UUID): Map<String, Any> = mapOf("vars" to service.runInput(flowId))

    @PutMapping("/flows/{flowId}/run-input")
    fun putRunInput(@PathVariable flowId: UUID, @RequestBody(required = false) req: RunInputRequest?): Map<String, Any> =
        mapOf("vars" to service.putRunInput(flowId, req?.vars))
}
