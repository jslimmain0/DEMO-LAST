package com.flowlink.protocol

import com.fasterxml.jackson.databind.JsonNode
import com.flowlink.common.error.BadRequestException
import com.flowlink.common.error.ForbiddenException
import com.flowlink.common.error.NotFoundException
import com.flowlink.agent.CentralResourceIdentity
import com.flowlink.common.host.LocalServerResources
import com.flowlink.common.host.CentralCodecDescriptor
import com.flowlink.common.host.CentralProtocolSnapshot
import com.flowlink.codec.CodecPlugin
import com.flowlink.common.json.JsonService
import com.flowlink.common.tcp.TcpBytes
import com.flowlink.execution.engine.SecretMasker
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
    private val localServerResources: org.springframework.beans.factory.ObjectProvider<LocalServerResources>? = null,
) : ProtocolResources {
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
        if (spec.schemaVersion == 2) {
            val boundaryErrors = ProtocolCompiler.jsonErrors(json.readTree(raw))
            if (boundaryErrors.isNotEmpty()) throw ProtocolCompiler.CompileException(boundaryErrors)
        }
        if (workspace.localRuntime && ProtocolCompiler.pluginRefs(spec).isNotEmpty())
            throw BadRequestException("개인 프로토콜에서는 플러그인을 사용할 수 없습니다. 기존 플러그인을 제거하세요.")
        try { ProtocolCompiler.compile(spec) } catch (e: ProtocolCompiler.CompileException) {
            if (spec.schemaVersion == 2) throw e
            throw BadRequestException(e.errors.joinToString(" · ") { it.message })
        }
        return spec
    }

    override fun plugins(workspaceId: UUID?): ProtocolCodec.PluginLookup = ProtocolCodec.PluginLookup { transforms.codec(it, workspaceId) }

    override fun plugins(workspaceId: UUID?, resourceIdentity: CentralResourceIdentity?): ProtocolCodec.PluginLookup =
        if (central(workspaceId, resourceIdentity)) CentralProtocolCodecs(serverResources(), resourceIdentity!!).lookup()
        else plugins(workspaceId)

    @Transactional(readOnly = true)
    override fun spec(reference: String, workspaceId: UUID?): ProtocolSpec =
        specOf(resolveId(reference, workspaceId), workspaceId = workspaceId)

    override fun spec(reference: String, workspaceId: UUID?, resourceIdentity: CentralResourceIdentity?): ProtocolSpec =
        if (central(workspaceId, resourceIdentity)) serverResources().protocolSpec(reference, resourceIdentity!!)
        else spec(reference, workspaceId)

    override fun snapshot(reference: String, workspaceId: UUID?, resourceIdentity: CentralResourceIdentity?): ResolvedProtocol {
        if (!central(workspaceId, resourceIdentity)) return capture(reference, workspaceId).let {
            ResolvedProtocol(it.spec, ProtocolCodec.PluginLookup { id -> it.codecs[id] }, it.fingerprint)
        }
        val server = serverResources()
        val captured = server.protocolSnapshot(reference, resourceIdentity!!)
        if (captured.fingerprint != fingerprintOf(captured.spec, captured.codecs))
            throw IllegalStateException("서버 전문·코덱 버전 응답이 일치하지 않습니다.")
        return ResolvedProtocol(captured.spec, CentralProtocolCodecs(server, resourceIdentity).lookup(captured.codecs), captured.fingerprint)
    }

    private fun central(workspaceId: UUID?, identity: CentralResourceIdentity?): Boolean =
        workspace.localRuntime && workspaceId == null && identity != null
    private fun serverResources(): LocalServerResources = localServerResources?.ifAvailable
        ?: throw IllegalStateException("서버 프로토콜 연결이 준비되지 않았습니다.")

    private fun summary(p: Protocol): ProtocolDtos.Summary {
        val s = try { json.mapper().readValue(p.specJson, ProtocolSpec::class.java) } catch (e: Exception) { ProtocolSpec() }
        val compiled = runCatching { ProtocolCompiler.compile(s) }.getOrNull()
        return ProtocolDtos.Summary(p.id, p.name, s.encoding ?: "EUC-KR", s.messagesOrEmpty().size, p.updatedAt ?: p.createdAt, p.workspaceKey,
            s.schemaVersion ?: 1, s.transactions.orEmpty().size, compiled?.requiredCapabilities.orEmpty())
    }
    private fun detail(p: Protocol): ProtocolDtos.Detail {
        val report = validate(json.readTree(p.specJson))
        return ProtocolDtos.Detail(p.id, p.name, json.readTree(p.specJson), p.createdAt, p.updatedAt, p.workspaceKey,
            report.schemaVersion, report.requiredCapabilities, report.compiledSummary, report.warnings)
    }

    fun validate(raw: JsonNode?): ProtocolDtos.CompilationReport = try {
        val spec = parse(raw?.toString())
        val compiled = ProtocolCompiler.compile(spec)
        ProtocolDtos.CompilationReport(true, compiled.schemaVersion, compiled.requiredCapabilities, compiled.summary)
    } catch (e: ProtocolCompiler.CompileException) {
        ProtocolDtos.CompilationReport(false, raw?.path("schemaVersion")?.asInt(1) ?: 1, errors = e.errors.map {
            ProtocolDtos.PreviewError(null, it.message, it.code, it.path, it.repairHint)
        })
    } catch (e: Exception) {
        ProtocolDtos.CompilationReport(false, errors = listOf(ProtocolDtos.PreviewError(null, "spec 형식 또는 의존성을 확인하세요.", path = "spec", repairHint = "프로토콜 스키마와 코덱 승인을 확인하세요.")))
    }

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

    private data class CapturedProtocol(val spec: ProtocolSpec, val codecs: Map<String, CodecPlugin>, val descriptors: List<CentralCodecDescriptor>, val fingerprint: String)

    /** spec과 실제 구현/승인 버전을 함께 복사한다. 이후 registry가 바뀌어도 이 snapshot은 바뀌지 않는다. */
    private fun capture(reference: String, workspaceId: UUID?): CapturedProtocol = synchronized(transforms) {
        val spec = specOf(resolveId(reference, workspaceId), workspaceId = workspaceId)
        val ids = ProtocolCompiler.pluginRefs(spec).mapNotNull { it.id }.distinct().sorted()
        val codecs = ids.associateWith { id -> transforms.codec(id, workspaceId)
            ?: throw NotFoundException("전문이 사용하는 코덱이 이 워크스페이스에 없습니다: $id") }
        val descriptors = ids.map { id ->
            val codec = codecs.getValue(id)
            CentralCodecDescriptor(id, codec.label(), if (codec is com.flowlink.codec.MessageCodec) "message" else "field",
                transforms.fingerprint(id, workspaceId) ?: throw NotFoundException("전문 코덱 승인 버전이 없습니다: $id"))
        }
        CapturedProtocol(spec, codecs, descriptors, fingerprintOf(spec, descriptors))
    }

    private fun fingerprintOf(spec: ProtocolSpec, descriptors: List<CentralCodecDescriptor>): String =
        ProtocolFingerprint.of(spec, descriptors.associate { it.id to it.fingerprint })

    /** 실제로 실행되는 스키마와 승인된 필드/메시지 코덱을 함께 고정한다. */
    @Transactional(readOnly = true)
    fun fingerprint(reference: String, workspaceId: UUID? = null): String = capture(reference, workspaceId).fingerprint

    @Transactional(readOnly = true)
    fun resourceSnapshot(reference: String, workspaceId: UUID? = null): CentralProtocolSnapshot = capture(reference, workspaceId).let {
        CentralProtocolSnapshot(it.spec, it.descriptors, it.fingerprint)
    }

    fun fingerprint(reference: String, workspaceId: UUID?, resourceIdentity: CentralResourceIdentity?): String =
        if (central(workspaceId, resourceIdentity)) serverResources().protocolFingerprint(reference, resourceIdentity!!)
        else fingerprint(reference, workspaceId)

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
        val action = req.action ?: "assemble"
        if (action !in setOf("assemble", "parse")) throw BadRequestException("action은 assemble 또는 parse여야 합니다.")
        if (req.direction != null && req.direction !in setOf("send", "recv")) throw BadRequestException("direction은 send 또는 recv여야 합니다.")
        if (req.frameDirection != null && req.frameDirection !in setOf("send", "recv")) throw BadRequestException("frameDirection은 send 또는 recv여야 합니다.")
        val dir = if ((req.direction ?: if (action == "parse") "recv" else "send") == "recv") Direction.RECV else Direction.SEND
        val phase = req.phase ?: if ((req.frameDirection ?: req.direction ?: "send") == "recv") "response" else "request"
        if (phase !in setOf("request", "requestAck", "response", "responseAck")) throw BadRequestException("유효하지 않은 phase입니다.")
        if (phase.endsWith("Ack") && (req.transactionKey == null || req.frameDirection != null)) throw BadRequestException("ACK 단계는 transactionKey가 필요하며 frameDirection을 함께 지정할 수 없습니다.")
        if (req.phase != null && req.frameDirection != null && req.frameDirection != if (phase == "request") "send" else "recv") throw BadRequestException("phase와 frameDirection이 다릅니다.")
        if (action == "assemble" && req.bytesB64 != null) throw BadRequestException("조립에는 bytesB64를 지정할 수 없습니다.")
        val values = scopes.scope(tenant(), req.environment, cached = false, workspaceId = wsId)
        var sensitive = SecretMasker.usesSecrets(values.secrets.values, spec, req.values, req.requestFields, req.responseFields)
        val hideCodecErrors = sensitive || (values.secrets.isNotEmpty() && ProtocolCompiler.pluginRefs(spec).isNotEmpty())
        return try {
            val e = if (action == "parse") {
                val b64 = req.bytesB64 ?: throw BadRequestException("파싱할 bytesB64가 필요합니다.")
                if (b64.length > ((ProtocolSpec.MAX_MESSAGE + 2) / 3) * 4) throw BadRequestException("입력은 1MB 이하여야 합니다.")
                val raw = try { java.util.Base64.getDecoder().decode(b64) } catch (_: IllegalArgumentException) { throw BadRequestException("bytesB64는 올바른 Base64여야 합니다.") }
                ProtocolCompiler.parse(spec, raw, req.key, req.transactionKey, phase, req.requestFields, req.responseFields, plugins(wsId), values.resolver(), dir)
            } else ProtocolCompiler.assemble(spec, req.key, req.values.orEmpty(), req.transactionKey, phase, req.requestFields, req.responseFields, plugins(wsId), values.resolver(), dir)
            sensitive = sensitive || SecretMasker.usesSecrets(values.secrets.values, e.values)
            val bytes = if (sensitive) ByteArray(e.bytes.size) { '*'.code.toByte() } else values.maskBytes(e.bytes)
            ProtocolDtos.PreviewResult(e.bytes.size, TcpBytes.hexDump(bytes), TcpBytes.printable(bytes, spec.charset()),
                e.fields.map { it.copy(value = if (sensitive) "***" else values.mask(it.value), warn = it.warn?.let { if (sensitive) SecretMasker.DERIVED_ERROR else values.mask(it) }) }, emptyList(), if (sensitive) emptyList() else e.warnings.map(values::mask),
                java.util.Base64.getEncoder().encodeToString(bytes), e.phase, e.transactionKey, e.declaredLength, e.bytes.size, e.lengthAdjustment,
                listOf(mapOf("code" to "VALID", "phase" to phase, "valid" to true)))
        } catch (e: ProtocolCompiler.ProtocolFailure) {
            ProtocolDtos.PreviewResult(0, "", "", emptyList(), listOf(ProtocolDtos.PreviewError(null, if (hideCodecErrors) SecretMasker.DERIVED_ERROR else values.mask(e.message ?: "검증 실패"), e.code, e.path, if (hideCodecErrors) SecretMasker.DERIVED_ERROR else e.repairHint)), phase = phase,
                validations = listOf(mapOf("valid" to false, "code" to e.code, "expectedBytes" to e.expectedBytes, "actualBytes" to e.actualBytes)))
        } catch (e: ProtocolCodec.ProtocolException) {
            ProtocolDtos.PreviewResult(0, "", "", emptyList(), listOf(ProtocolDtos.PreviewError(if (hideCodecErrors) null else e.field, if (hideCodecErrors) SecretMasker.DERIVED_ERROR else values.mask(e.message ?: "조립 실패"))))
        } catch (e: Exception) { // 코덱 플러그인 등이 던진 예외도 편집기 에러로(500 대신)
            ProtocolDtos.PreviewResult(0, "", "", emptyList(), listOf(ProtocolDtos.PreviewError(null, if (hideCodecErrors) SecretMasker.DERIVED_ERROR else values.mask("조립 중 오류: ${e.message ?: e}"))))
        }
    }

    private fun find(id: UUID): Protocol = repo.findByIdAndTenantId(id, tenant()).orElseThrow { NotFoundException("프로토콜이 없습니다: $id") }.also { resourceWorkspace.requireRead(it.workspaceKey) }
}
