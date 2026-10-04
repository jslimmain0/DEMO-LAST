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
    private val scopes: com.flowlink.mock.MockSecretProvider,
    private val events: ApplicationEventPublisher,
    private val resourceWorkspace: com.flowlink.workspace.ResourceWorkspace,
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

    fun plugins(workspaceId: UUID? = null): ProtocolCodec.PluginLookup = ProtocolCodec.PluginLookup { transforms.codec(it, workspaceId) }

    private fun summary(p: Protocol): ProtocolDtos.Summary {
        val s = try { json.mapper().readValue(p.specJson, ProtocolSpec::class.java) } catch (e: Exception) { ProtocolSpec() }
        return ProtocolDtos.Summary(p.id, p.name, s.encoding ?: "EUC-KR", s.messagesOrEmpty().size, p.updatedAt ?: p.createdAt, p.workspaceKey)
    }
    private fun detail(p: Protocol) = ProtocolDtos.Detail(p.id, p.name, json.readTree(p.specJson), p.createdAt, p.updatedAt, p.workspaceKey)

    @Transactional(readOnly = true) fun list(workspaceId: String? = null): List<ProtocolDtos.Summary> = repo.findByTenantIdAndWorkspaceKeyOrderByNameAsc(tenant(), resourceWorkspace.read(workspaceId)).map { summary(it) }
    @Transactional(readOnly = true) fun get(id: UUID): ProtocolDtos.Detail = detail(find(id))

    /** 실행기/리스너용 — tenantId 를 직접 줄 수 있다(리스너 스레드). */
    @Transactional(readOnly = true)
    fun specOf(id: UUID, tenantId: String? = null, workspaceId: UUID? = null): ProtocolSpec {
        val p = repo.findByIdAndTenantId(id, tenantId ?: tenant()).orElseThrow { NotFoundException("프로토콜이 없습니다: $id") }
        if (p.workspaceKey != resourceWorkspace.key(workspaceId)) throw NotFoundException("이 워크스페이스의 프로토콜이 아닙니다: $id")
        return json.mapper().readValue(p.specJson, ProtocolSpec::class.java)
    }

    @Transactional(readOnly = true)
    fun resolveId(reference: String, workspaceId: UUID? = null): UUID {
        val scope = resourceWorkspace.key(workspaceId)
        val parsed = runCatching { UUID.fromString(reference) }.getOrNull()
        val row = if (parsed != null) repo.findByIdAndTenantId(parsed, tenant()).orElse(null)
            else repo.findByTenantIdAndWorkspaceKeyOrderByNameAsc(tenant(), scope).firstOrNull { it.name == reference }
        if (row == null || row.workspaceKey != scope) throw NotFoundException("이 워크스페이스에 프로토콜이 없습니다: $reference")
        return row.id
    }

    @Transactional(readOnly = true)
    fun canonicalReference(reference: String, workspaceId: UUID? = null): String = repo.findById(resolveId(reference, workspaceId)).orElseThrow().name

    /** 실제로 실행되는 스키마와 승인된 필드/메시지 코덱을 함께 고정한다. */
    @Transactional(readOnly = true)
    fun fingerprint(reference: String, workspaceId: UUID? = null): String {
        val spec = specOf(resolveId(reference, workspaceId), workspaceId = workspaceId)
        val pluginIds = (spec.headerOrEmpty() + spec.messagesOrEmpty().flatMap { it.fieldsOrEmpty() }).mapNotNull { it.plugin?.id } + spec.messagePlugins.orEmpty().mapNotNull { it.id }
        val dependencies = pluginIds.distinct().sorted().associateWith { id ->
            transforms.fingerprint(id, workspaceId) ?: throw NotFoundException("전문이 사용하는 코덱이 이 워크스페이스에 없습니다: $id")
        }
        val canonical = json.mapper().copy().configure(com.fasterxml.jackson.databind.SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS, true).writeValueAsBytes(mapOf("spec" to spec, "codecs" to dependencies))
        return java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(canonical))
    }

    @Transactional
    fun create(name: String?, spec: JsonNode?, workspaceId: String? = null): ProtocolDtos.Detail {
        val scope = resourceWorkspace.write(workspaceId)
        val n = normName(name)
        if (repo.existsByTenantIdAndWorkspaceKeyAndName(tenant(), scope, n)) throw BadRequestException("이미 같은 이름의 프로토콜이 있습니다: $n")
        val raw = spec?.toString()
        parse(raw)
        return detail(repo.saveAndFlush(Protocol.create(tenant(), n, raw!!).also { it.workspaceKey = scope }))
    }

    @Transactional
    fun update(id: UUID, name: String?, spec: JsonNode?): ProtocolDtos.Detail {
        requireApproved()
        val p = find(id)
        resourceWorkspace.requireWrite(p.workspaceKey)
        if (name != null) {
            val n = normName(name)
            if (n != p.name && repo.existsByTenantIdAndWorkspaceKeyAndName(tenant(), p.workspaceKey, n)) throw BadRequestException("이미 같은 이름의 프로토콜이 있습니다: $n")
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
    fun delete(id: UUID) { val p = find(id); resourceWorkspace.requireWrite(p.workspaceKey); repo.delete(p) }

    /** 편집 중 spec 으로 조립 — 검증/조립 에러는 200 + errors(편집기가 필드 옆에 표시). */
    fun preview(req: ProtocolDtos.PreviewRequest, workspaceId: String? = null): ProtocolDtos.PreviewResult {
        val scope = resourceWorkspace.write(workspaceId)
        val wsId = com.flowlink.workspace.ResourceWorkspace.id(scope)
        val spec = parse(req.spec?.toString())
        val key = req.key?.trim().orEmpty()
        if (key.isEmpty()) return ProtocolDtos.PreviewResult(0, "", "", emptyList(), listOf(ProtocolDtos.PreviewError(null, "전문(key)을 고르세요.")))
        val dir = if ((req.direction ?: "send").equals("recv", ignoreCase = true)) Direction.RECV else Direction.SEND
        val values = scopes.scope(tenant(), req.environment, cached = false, workspaceId = wsId)
        return try {
            val e = ProtocolCodec.encode(spec, key, req.values ?: emptyMap(), dir, plugins(wsId), resolve = values.resolver())
            val bytes = values.maskBytes(e.bytes)
            ProtocolDtos.PreviewResult(e.bytes.size, TcpBytes.hexDump(bytes), TcpBytes.printable(bytes, spec.charset()), e.fields.map { it.copy(value = values.mask(it.value)) }, emptyList(), e.warnings.map(values::mask))
        } catch (e: ProtocolCodec.ProtocolException) {
            ProtocolDtos.PreviewResult(0, "", "", emptyList(), listOf(ProtocolDtos.PreviewError(e.field, values.mask(e.message ?: "조립 실패"))))
        } catch (e: Exception) { // 코덱 플러그인 등이 던진 예외도 편집기 에러로(500 대신)
            ProtocolDtos.PreviewResult(0, "", "", emptyList(), listOf(ProtocolDtos.PreviewError(null, values.mask("조립 중 오류: ${e.message ?: e}"))))
        }
    }

    private fun find(id: UUID): Protocol = repo.findByIdAndTenantId(id, tenant()).orElseThrow { NotFoundException("프로토콜이 없습니다: $id") }.also { resourceWorkspace.requireRead(it.workspaceKey) }
}
