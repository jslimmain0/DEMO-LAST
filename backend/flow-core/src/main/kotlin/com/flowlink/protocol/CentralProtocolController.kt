package com.flowlink.protocol

import com.flowlink.codec.CodecCtx
import com.flowlink.codec.FieldCodec
import com.flowlink.codec.MessageCodec
import com.flowlink.common.error.BadRequestException
import com.flowlink.common.error.ForbiddenException
import com.flowlink.common.error.NotFoundException
import com.flowlink.common.host.CentralCodecDescriptor
import com.flowlink.common.host.CentralCodecRequest
import com.flowlink.common.host.CentralCodecResult
import com.flowlink.common.host.CentralProtocolSnapshot
import com.flowlink.transform.TransformRegistry
import com.flowlink.workspace.WorkspaceService
import org.springframework.http.CacheControl
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.*
import java.util.Base64

/** PC 실행기의 정의 조회/코덱 RPC. 스크립트 원문은 전달하지 않고 승인된 공용 구현만 실행한다. */
@RestController
@RequestMapping("/api/v1/agent")
class CentralProtocolController(
    private val workspace: WorkspaceService,
    private val protocols: ProtocolService,
    private val registry: TransformRegistry,
) {
    data class Fingerprint(val fingerprint: String)

    private fun requireDevice(device: String?) {
        if (workspace.localRuntime || !workspace.isApproved(workspace.currentUsername()))
            throw ForbiddenException("중앙 자원은 가입 승인된 서버 계정으로 사용하세요.")
        workspace.requireWrite(workspace.currentUsername(), null)
        if (device.isNullOrBlank() || device.length > 100) throw BadRequestException("PC 실행기 식별자가 필요합니다.")
    }

    private fun validReference(raw: String): String = raw.trim().also {
        if (it.isEmpty() || it.length > 120) throw BadRequestException("프로토콜 참조가 올바르지 않습니다.")
    }

    @GetMapping("/central-protocols/spec")
    fun spec(@RequestParam reference: String, @RequestHeader("X-FlowLink-Device", required = false) device: String?): ResponseEntity<ProtocolSpec> {
        requireDevice(device)
        return noStore(protocols.spec(validReference(reference), null))
    }

    @GetMapping("/central-protocols/fingerprint")
    fun fingerprint(@RequestParam reference: String, @RequestHeader("X-FlowLink-Device", required = false) device: String?): ResponseEntity<Fingerprint> {
        requireDevice(device)
        return noStore(Fingerprint(protocols.fingerprint(validReference(reference), null)))
    }

    @GetMapping("/central-protocols/snapshot")
    fun snapshot(@RequestParam reference: String, @RequestHeader("X-FlowLink-Device", required = false) device: String?): ResponseEntity<CentralProtocolSnapshot> {
        requireDevice(device)
        return noStore(protocols.resourceSnapshot(validReference(reference), null))
    }

    @GetMapping("/central-codecs/catalog")
    fun codecs(@RequestHeader("X-FlowLink-Device", required = false) device: String?): ResponseEntity<List<CentralCodecDescriptor>> {
        requireDevice(device)
        return noStore(synchronized(registry) { registry.codecs(null).map {
            CentralCodecDescriptor(it.id(), it.label(), if (it is MessageCodec) "message" else "field",
                registry.fingerprint(it.id(), null) ?: throw NotFoundException("서버 코덱 버전이 없습니다: ${it.id()}"))
        } })
    }

    @PostMapping("/central-codecs/invoke")
    fun invoke(@RequestBody request: CentralCodecRequest, @RequestHeader("X-FlowLink-Device", required = false) device: String?): ResponseEntity<CentralCodecResult> {
        requireDevice(device)
        if (request.id.isBlank() || request.id.length > 200 || request.operation !in setOf("encode", "decode") || request.direction !in setOf("send", "recv"))
            throw BadRequestException("코덱 실행 정보가 올바르지 않습니다.")
        if (!validMap(request.message) || !validMap(request.config)) throw BadRequestException("코덱 파라미터가 너무 큽니다.")
        val codec = synchronized(registry) {
            if (request.fingerprint.isBlank() || request.fingerprint != registry.fingerprint(request.id, null))
                throw BadRequestException("서버 코덱 승인 버전이 바뀌었습니다. 다시 실행하세요.")
            registry.codec(request.id, null) ?: throw NotFoundException("서버에 승인된 코덱이 없습니다: ${request.id}")
        }
        val context = CodecCtx(request.field, request.message, request.config, request.direction)
        val result = when (codec) {
            is FieldCodec -> {
                val field = request.field
                val value = request.value
                if (field == null || field.len !in 0..MAX_BYTES || field.name.length > 200 || field.type.length > 100 || field.pad.length > 100 || value == null || value.length > MAX_BYTES || request.bytesBase64 != null)
                    throw BadRequestException("필드 코덱 입력이 올바르지 않습니다.")
                val output = safeCodec { if (request.operation == "encode") codec.encode(value, context) else codec.decode(value, context) }
                if (output.length > MAX_BYTES) throw BadRequestException("코덱 결과가 너무 큽니다.")
                CentralCodecResult(value = output)
            }
            is MessageCodec -> {
                if (request.field != null || request.value != null || request.bytesBase64 == null || request.bytesBase64.length > MAX_BASE64)
                    throw BadRequestException("메시지 코덱 입력이 올바르지 않습니다.")
                val bytes = try { Base64.getDecoder().decode(request.bytesBase64) } catch (_: IllegalArgumentException) { throw BadRequestException("코덱 바이트 입력이 올바르지 않습니다.") }
                if (bytes.size > MAX_BYTES) throw BadRequestException("코덱 입력이 너무 큽니다.")
                val output = safeCodec { if (request.operation == "encode") codec.encode(bytes, context) else codec.decode(bytes, context) }
                if (output.size > MAX_BYTES) throw BadRequestException("코덱 결과가 너무 큽니다.")
                CentralCodecResult(bytesBase64 = Base64.getEncoder().encodeToString(output))
            }
            else -> throw BadRequestException("지원하지 않는 서버 코덱입니다.")
        }
        return noStore(result)
    }

    private fun validMap(values: Map<String, String>): Boolean = values.size <= 200 &&
        values.keys.all { it.length <= 200 } && values.values.sumOf { it.length.toLong() } <= MAX_BYTES
    private fun <T> safeCodec(action: () -> T): T = try { action() } catch (_: Exception) {
        throw BadRequestException("서버 코덱 실행에 실패했습니다. 입력과 파라미터를 확인하세요.")
    }
    private fun <T> noStore(value: T): ResponseEntity<T> = ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(value)

    companion object {
        private const val MAX_BYTES = 5 * 1024 * 1024
        private const val MAX_BASE64 = ((MAX_BYTES + 2) / 3) * 4
    }
}
