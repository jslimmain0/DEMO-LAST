package com.flowlink.transform

import com.flowlink.common.error.BadRequestException
import com.flowlink.common.error.ForbiddenException
import com.flowlink.common.error.NotFoundException
import com.flowlink.common.host.CentralTransformDescriptor
import com.flowlink.common.host.CentralTransformRequest
import com.flowlink.common.host.CentralTransformResult
import com.flowlink.workspace.WorkspaceService
import org.springframework.http.CacheControl
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.*

/** 승인 구현은 서버에서만 실행한다. PC에는 포트 메타와 실행 결과만 전달한다. */
@RestController
@RequestMapping("/api/v1/agent/central-transforms")
class CentralTransformController(private val workspace: WorkspaceService, private val registry: TransformRegistry) {
    private fun requireDevice(device: String?) {
        if (workspace.localRuntime || !workspace.isApproved(workspace.currentUsername())) throw ForbiddenException("중앙 자원은 가입 승인된 서버 계정으로 사용하세요.")
        workspace.requireWrite(workspace.currentUsername(), null)
        if (device.isNullOrBlank() || device.length > 100) throw BadRequestException("PC 실행기 식별자가 필요합니다.")
    }
    @GetMapping("/catalog")
    fun catalog(@RequestHeader("X-FlowLink-Device", required = false) device: String?): ResponseEntity<List<CentralTransformDescriptor>> {
        requireDevice(device)
        return noStore(synchronized(registry) { registry.list(null).map { CentralTransformDescriptor(it.id(), it.label(), it.description(), it.inputs(), it.outputs(), it.params(),
            registry.fingerprint(it.id(), null) ?: throw NotFoundException("서버 변환 버전이 없습니다: ${it.id()}")) } })
    }
    @PostMapping("/invoke")
    fun invoke(@RequestBody request: CentralTransformRequest, @RequestHeader("X-FlowLink-Device", required = false) device: String?): ResponseEntity<CentralTransformResult> {
        requireDevice(device)
        if (request.id.isBlank() || request.id.length > 200 || !validMap(request.inputs) || !validMap(request.config)) throw BadRequestException("변환 입력이 올바르지 않습니다.")
        val transform = synchronized(registry) {
            if (request.fingerprint.isBlank() || request.fingerprint != registry.fingerprint(request.id, null)) throw BadRequestException("서버 변환 승인 버전이 바뀌었습니다. 다시 실행하세요.")
            registry.get(request.id, null).orElseThrow { NotFoundException("서버에 승인된 변환이 없습니다: ${request.id}") }
        }
        val output = try { transform.apply(request.inputs, request.config) } catch (_: Exception) { throw BadRequestException("서버 변환에 실패했습니다. 입력과 파라미터를 확인하세요.") }
        if (!validMap(output)) throw BadRequestException("변환 결과가 너무 큽니다.")
        return noStore(CentralTransformResult(output))
    }
    private fun validMap(values: Map<String, String>) = values.size <= 200 && values.keys.all { it.length <= 200 } && values.values.sumOf { it.length.toLong() } <= 5 * 1024 * 1024
    private fun <T> noStore(value: T): ResponseEntity<T> = ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(value)
}
