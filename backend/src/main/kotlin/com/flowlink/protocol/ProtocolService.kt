package com.flowlink.protocol

import com.fasterxml.jackson.databind.JsonNode
import com.flowlink.common.error.BadRequestException
import com.flowlink.common.error.ForbiddenException
import com.flowlink.common.error.NotFoundException
import com.flowlink.common.json.JsonService
import com.flowlink.common.tcp.TcpBytes
import com.flowlink.common.tenant.TenantContext
import com.flowlink.core.domain.Protocol
import com.flowlink.core.repository.ProtocolRepository
import com.flowlink.transform.TransformRegistry
import com.flowlink.workspace.WorkspaceService
import org.springframework.context.ApplicationEventPublisher
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.util.UUID

/** 프로토콜 CRUD(테넌트 스코프, 쓰기=승인 사용자) + 편집 중 미리보기 + 실행기용 조회. */
@Service
class ProtocolService(
    private val repo: ProtocolRepository,
    private val json: JsonService,
    private val workspace: WorkspaceService,
    private val transforms: TransformRegistry,
    private val events: ApplicationEventPublisher,
) {
    private fun tenant(): String = TenantContext.getTenantId()
    private fun requireApproved() { if (!workspace.isApproved(workspace.currentUsername())) throw ForbiddenException("프로토콜 변경은 가입 승인 후 가능합니다.") }
    private fun normName(name: String?): String {
        val n = name?.trim().orEmpty()
        if (n.isEmpty()) throw BadRequestException("프로토콜 이름이 비었습니다.")
        if (n.length > 120) throw BadRequestException("프로토콜 이름은 120자 이하여야 합니다.")
        return n
    }

    /** JSON → 검증된 spec(에러는 400 한 줄로 합침). */
    fun parse(raw: String?): ProtocolSpec {
        if (raw.isNullOrBlank()) throw BadRequestException("spec 이 없습니다.")
        val spec = try { json.mapper().readValue(raw, ProtocolSpec::class.java) } catch (e: Exception) { throw BadRequestException("spec JSON 파싱 실패: ${e.message}") }
        val errs = spec.validate()
        if (errs.isNotEmpty()) throw BadRequestException(errs.joinToString(" · "))
        return spec
    }

    fun plugins(): ProtocolCodec.PluginLookup = ProtocolCodec.PluginLookup { transforms.codec(it) }

    private fun summary(p: Protocol): ProtocolDtos.Summary {
        val s = try { json.mapper().readValue(p.specJson, ProtocolSpec::class.java) } catch (e: Exception) { ProtocolSpec() }
        return ProtocolDtos.Summary(p.id, p.name, s.encoding ?: "EUC-KR", s.messagesOrEmpty().size, p.updatedAt ?: p.createdAt)
    }
    private fun detail(p: Protocol) = ProtocolDtos.Detail(p.id, p.name, json.readTree(p.specJson), p.createdAt, p.updatedAt)

    @Transactional(readOnly = true) fun list(): List<ProtocolDtos.Summary> = repo.findByTenantIdOrderByNameAsc(tenant()).map { summary(it) }
    @Transactional(readOnly = true) fun get(id: UUID): ProtocolDtos.Detail = detail(find(id))

    /** 실행기/리스너용 — tenantId 를 직접 줄 수 있다(리스너 스레드). */
    @Transactional(readOnly = true)
    fun specOf(id: UUID, tenantId: String? = null): ProtocolSpec {
        val p = repo.findByIdAndTenantId(id, tenantId ?: tenant()).orElseThrow { NotFoundException("프로토콜이 없습니다: $id") }
        return json.mapper().readValue(p.specJson, ProtocolSpec::class.java)
    }

    @Transactional
    fun create(name: String?, spec: JsonNode?): ProtocolDtos.Detail {
        requireApproved()
        val n = normName(name)
        if (repo.existsByTenantIdAndName(tenant(), n)) throw BadRequestException("이미 같은 이름의 프로토콜이 있습니다: $n")
        val raw = spec?.toString()
        parse(raw)
        return detail(repo.saveAndFlush(Protocol.create(tenant(), n, raw!!)))
    }

    @Transactional
    fun update(id: UUID, name: String?, spec: JsonNode?): ProtocolDtos.Detail {
        requireApproved()
        val p = find(id)
        if (name != null) {
            val n = normName(name)
            if (n != p.name && repo.existsByTenantIdAndName(tenant(), n)) throw BadRequestException("이미 같은 이름의 프로토콜이 있습니다: $n")
            p.name = n
        }
        if (spec != null && !spec.isNull) {
            val parsed = parse(spec.toString())
            p.specJson = spec.toString()
            events.publishEvent(ProtocolChangedEvent(p.id, parsed))
        }
        return detail(repo.saveAndFlush(p))
    }

    @Transactional
    fun delete(id: UUID) { requireApproved(); repo.findByIdAndTenantId(id, tenant()).ifPresent { repo.delete(it) } }

    /** 편집 중 spec 으로 조립 — 검증/조립 에러는 200 + errors(편집기가 필드 옆에 표시). */
    fun preview(req: ProtocolDtos.PreviewRequest): ProtocolDtos.PreviewResult {
        val spec = parse(req.spec?.toString())
        val key = req.key?.trim().orEmpty()
        if (key.isEmpty()) return ProtocolDtos.PreviewResult(0, "", "", emptyList(), listOf(ProtocolDtos.PreviewError(null, "전문(key)을 고르세요.")))
        val dir = if ((req.direction ?: "send").equals("recv", ignoreCase = true)) Direction.RECV else Direction.SEND
        return try {
            val e = ProtocolCodec.encode(spec, key, req.values ?: emptyMap(), dir, plugins())
            ProtocolDtos.PreviewResult(e.bytes.size, TcpBytes.hexDump(e.bytes), TcpBytes.printable(e.bytes, spec.charset()), e.fields, emptyList(), e.warnings)
        } catch (e: ProtocolCodec.ProtocolException) {
            ProtocolDtos.PreviewResult(0, "", "", emptyList(), listOf(ProtocolDtos.PreviewError(e.field, e.message ?: "조립 실패")))
        }
    }

    private fun find(id: UUID): Protocol = repo.findByIdAndTenantId(id, tenant()).orElseThrow { NotFoundException("프로토콜이 없습니다: $id") }
}
