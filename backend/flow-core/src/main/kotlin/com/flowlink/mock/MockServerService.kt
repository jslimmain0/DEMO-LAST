package com.flowlink.mock

import com.fasterxml.jackson.databind.JsonNode
import com.flowlink.common.error.BadRequestException
import com.flowlink.common.error.NotFoundException
import com.flowlink.common.json.JsonService
import com.flowlink.common.tcp.TcpBytes
import com.flowlink.execution.engine.SecretMasker
import com.flowlink.common.tenant.TenantContext
import com.flowlink.core.domain.MockServer
import com.flowlink.core.repository.MockServerRepository
import com.flowlink.mock.MockDtos.CreateMockServerRequest
import com.flowlink.mock.MockDtos.MockServerDetail
import com.flowlink.mock.MockDtos.MockServerSummary
import com.flowlink.mock.MockDtos.UpdateMockServerRequest
import com.flowlink.protocol.Direction
import com.flowlink.protocol.ProtocolCodec
import com.flowlink.protocol.ProtocolCompiler
import com.flowlink.protocol.ProtocolSpec
import com.flowlink.protocol.ProtocolDtos
import com.flowlink.protocol.TcpClient
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Instant
import java.util.Locale
import java.util.Optional
import java.util.UUID
import java.util.regex.Pattern

/** Mock 서버 관리(테넌트 + 워크스페이스 스코프 CRUD) + 서빙 조회(무인증, slug 팀 스코프 유니크). */
@Service
class MockServerService(
    private val repository: MockServerRepository,
    private val json: JsonService,
    private val tcpRegistry: TcpMockRegistry,
    private val store: MockRuntimeStore,
    private val workspace: com.flowlink.workspace.WorkspaceService,
    private val secretProvider: MockSecretProvider,
    private val transforms: com.flowlink.transform.TransformRegistry,
    private val versionRepo: com.flowlink.core.repository.MockServerVersionRepository,
    private val flowRepo: com.flowlink.core.repository.FlowRepository,
    private val flowVersionRepo: com.flowlink.core.repository.FlowVersionRepository,
    private val protocolService: com.flowlink.protocol.ProtocolService,
    private val protocolRepo: com.flowlink.core.repository.ProtocolRepository,
    private val env: org.springframework.core.env.Environment,
    private val resourceWorkspace: com.flowlink.workspace.ResourceWorkspace,
    private val connection: org.springframework.beans.factory.ObjectProvider<com.flowlink.common.host.LocalServerConnection>? = null,
    private val trials: MockTrialStore? = null,
) {

    /** 검증과 미리보기는 정의·리스너·상태 저장소에 쓰지 않는다. */
    fun validate(req: MockDtos.PlanRequest): ProtocolDtos.CompilationReport = try {
        val wsId = workspace.resolveId(req.workspaceId)
        workspace.requireRead(workspace.currentUsername(), wsId)
        val raw = req.spec ?: throw BadRequestException("검증할 전체 spec이 필요합니다.")
        if (raw.hasNonNull("resourceIdentity")) throw BadRequestException("resourceIdentity는 서버 소유 metadata입니다.")
        val spec = parseSpec(normalizeResourceSpec(raw).toString())
        if (raw.has("transactions") || raw.has("ackMessages") || raw.path("tcp").has("transactions") || raw.path("tcp").has("ackMessages"))
            throw BadRequestException("transactions/ackMessages는 Mock이 아닌 ProtocolSpec에 저장하세요.")
        if (req.type == "HTTP" && spec.tcp != null || req.type == "TCP" && spec.tcp == null) throw BadRequestException("type과 spec의 HTTP/TCP 종류가 다릅니다.")
        val tcpDefinition = spec.tcp
        if (req.enabled == true && tcpDefinition != null && tcpDefinition.protocolId.isNullOrBlank()) throw BadRequestException("TCP 활성화에는 프로토콜이 필요합니다.")
        validateTcp(spec, wsId)
        val scope = secretProvider.scope(tenant(), req.environment ?: spec.environment, cached = false, workspaceId = wsId, spec = spec)
        val proto = previewProtocol(spec, scope, wsId, req.protocolSpec)
        val compiled = proto?.let(ProtocolCompiler::compile)
        val transformsUsed = (listOf(spec.codec) + spec.routesOrEmpty().map { it.codec }).flatMap { it?.request.orEmpty() + it?.response.orEmpty() }.mapNotNull { it.id }.filter { it.isNotBlank() }.distinct()
        for (id in transformsUsed) if ((scope.transformLookup?.invoke(id) ?: transforms.get(id, resourceScope(spec, wsId)).orElse(null)) == null)
            throw ProtocolCompiler.CompileException(listOf(ProtocolCompiler.ValidationError("PLUGIN_NOT_APPROVED", "codec", "필요한 승인 변환 플러그인이 없습니다.", "plugin_list에서 승인본 id를 확인하세요.")))
        for (plugin in proto?.let(ProtocolCompiler::pluginRefs).orEmpty()) {
            if ((scope.codecLookup ?: protocolService.plugins(resourceScope(spec, wsId), resourceIdentity(spec))).find(plugin.id.orEmpty()) == null)
                throw ProtocolCompiler.CompileException(listOf(ProtocolCompiler.ValidationError("PLUGIN_NOT_APPROVED", "protocol.plugins", "필요한 승인 전문 코덱이 없습니다.")))
        }
        val secrets = Regex("\\{\\{\\s*([^{}]+?)@secret\\s*}}").findAll(raw.toString() + (req.protocolSpec?.toString() ?: "")).map { it.groupValues[1].trim() }.distinct().toList()
        for (name in secrets) if (!scope.secrets.containsKey(name)) throw ProtocolCompiler.CompileException(listOf(ProtocolCompiler.ValidationError("SECRET_NOT_FOUND", "dependencies.secrets", "필요한 시크릿이 없습니다.", "선택 환경의 시크릿 이름과 등록을 확인하세요.")))
        ProtocolDtos.CompilationReport(true, compiled?.schemaVersion ?: 1, compiled?.requiredCapabilities.orEmpty(),
            compiled?.summary.orEmpty() + mapOf("routeCount" to spec.routesOrEmpty().size, "tcpRuleCount" to spec.tcp?.rulesOrEmpty()?.size,
                "requiredTransforms" to transformsUsed, "secretNames" to secrets, "environment" to (req.environment ?: spec.environment), "envSource" to spec.envSource))
    } catch (e: ProtocolCompiler.CompileException) {
        ProtocolDtos.CompilationReport(false, errors = e.errors.map { ProtocolDtos.PreviewError(null, it.message, it.code, it.path, it.repairHint) })
    } catch (e: Exception) {
        val code = when { e is NotFoundException -> "RESOURCE_NOT_FOUND"; e.message?.contains("환경") == true -> "ENVIRONMENT_NOT_FOUND"; else -> "INVALID_SCHEMA" }
        ProtocolDtos.CompilationReport(false, errors = listOf(ProtocolDtos.PreviewError(null, "Mock 정의·환경·의존성을 확인하세요.", code, "spec", "참조한 프로토콜·환경·승인 코덱·포트 범위를 확인하세요.")))
    }

    /** MCP 전체 교체도 한 트랜잭션으로 처리하여 실패한 생성 초안을 남기지 않는다. */
    @Transactional
    fun upsert(req: MockDtos.PlanRequest): MockServerDetail {
        val report = validate(req)
        if (!report.valid) throw ProtocolCompiler.CompileException(report.errors.map { ProtocolCompiler.ValidationError(it.code, it.path ?: "spec", it.message, it.repairHint ?: "규격을 확인하세요.") })
        val wsId = workspace.resolveId(req.workspaceId)
        val slug = req.slug ?: throw BadRequestException("slug가 필요합니다.")
        val previous = repository.findByTenantIdAndWorkspaceKeyAndSlug(tenant(), resourceWorkspace.key(wsId), slug).orElse(null)
        val current = previous?.let { toDetail(it) } ?: create(CreateMockServerRequest(req.name ?: slug, slug, req.type, req.workspaceId))
        if (req.type != null && req.type != current.kind) throw BadRequestException("저장된 Mock 종류와 type이 다릅니다.")
        if (req.enabled == false) repository.findById(current.id).orElseThrow().isEnabled = false
        updateSpec(current.id, req.spec, "mcp")
        if (req.name != null || req.enabled != null) updateMeta(current.id, UpdateMockServerRequest(req.name, req.enabled))
        return get(current.id)
    }

    private fun previewProtocol(spec: MockSpec, scope: MockSecretProvider.Scope, wsId: UUID?, override: JsonNode?): ProtocolSpec? {
        if (override != null) {
            if (spec.tcp == null) throw BadRequestException("HTTP 미리보기에는 protocolSpec을 지정할 수 없습니다.")
            return protocolService.parse(override.toString())
        }
        val id = spec.tcp?.protocolId?.takeIf { it.isNotBlank() } ?: return null
        return scope.protocol ?: protocolService.spec(id, resourceScope(spec, wsId), resourceIdentity(spec))
    }

    fun preview(req: MockDtos.PlanRequest): Map<String, Any?> {
        val wsId = workspace.resolveId(req.workspaceId)
        workspace.requireRead(workspace.currentUsername(), wsId)
        val saved = req.slug?.let { repository.findByTenantIdAndWorkspaceKeyAndSlug(tenant(), resourceWorkspace.key(wsId), it).orElseThrow { NotFoundException("Mock이 없습니다.") } }
        if (saved != null && req.type != null && req.type != saved.kind.name) throw BadRequestException("저장된 Mock 종류와 type이 다릅니다.")
        val raw = req.spec ?: saved?.specJson?.let(json::readTree) ?: throw BadRequestException("미저장 미리보기에는 전체 spec이 필요합니다.")
        val spec = parseSpec((if (req.spec == null) raw else normalizeResourceSpec(raw)).toString()).let { if (req.environment == null) it else it.copy(environment = req.environment) }
        val scope = secretProvider.scope(tenant(), spec.environment, cached = false, workspaceId = wsId, spec = spec)
        val request = req.request ?: throw BadRequestException("합성 request가 필요합니다.")
        val snapshot = saved?.let { store.snapshot(it.id) } ?: MockRuntimeStore.Snapshot(emptyMap(), 1000, emptyMap(), 0)
        val result = try {
            if (spec.tcp != null) previewTcp(spec, scope, wsId, req.protocolSpec, request, snapshot.seq + 1) else previewHttp(spec, scope, wsId, request, snapshot)
        } catch (e: Exception) {
            val codecInput = scope.secrets.isNotEmpty() && if (spec.tcp != null) runCatching {
                previewProtocol(spec, scope, wsId, req.protocolSpec)?.let { ProtocolCompiler.pluginRefs(it).isNotEmpty() } == true
            }.getOrDefault(false) else (listOf(spec.codec) + spec.routesOrEmpty().map { it.codec }).any { !it?.request.isNullOrEmpty() || !it?.response.isNullOrEmpty() }
            if (codecInput || SecretMasker.usesSecrets(scope.secrets.values, spec, scope.protocol, req.protocolSpec, request)) throw BadRequestException(SecretMasker.DERIVED_ERROR)
            throw e
        }
        return mapOf("unsaved" to (req.spec != null), "definition" to saved?.let { mapOf("id" to it.id, "version" to it.currentVersionOrZero()) },
            "snapshot" to mapOf("state" to snapshot.state.mapValues { scope.mask(it.value) }, "seq" to snapshot.seq, "virtualSeq" to snapshot.seq + 1, "hits" to snapshot.hits),
            "sideEffects" to false) + result
    }

    private fun previewHttp(spec: MockSpec, scope: MockSecretProvider.Scope, wsId: UUID?, request: JsonNode, snapshot: MockRuntimeStore.Snapshot): Map<String, Any?> {
        if (request.has("url")) throw BadRequestException("미리보기는 URL을 호출하지 않습니다. method/path를 사용하세요.")
        val mapper = json.mapper()
        fun values(node: JsonNode) = if (node.isObject) node.fields().asSequence().associate { it.key to it.value.asText() } else emptyMap()
        val headers = values(request.path("headers")).mapKeys { it.key.lowercase(Locale.ROOT) }
        val body = request.get("body")?.let { if (it.isTextual) it.asText() else it.toString() }.orEmpty()
        val path = request.path("path").asText("/")
        if (!path.startsWith("/") || path.startsWith("//")) throw BadRequestException("path는 Mock 내부 경로여야 합니다.")
        val ct = headers["content-type"] ?: "application/json"
        val input = MockHttp.MockRequest(request.path("method").asText("GET").uppercase(Locale.ROOT), path, values(request.path("query")), headers, body,
            MockHttp.parseBodyFields(body, ct, MockHttp.charsetFromContentType(ct), mapper))
        val runtime = MockRuntime()
        val lookup: (String) -> com.flowlink.transform.FlowTransform? = scope.transformLookup ?: { transforms.get(it, resourceScope(spec, wsId)).orElse(null) }
        var route: MockSpec.MockRoute? = null
        val match = runtime.match(spec.routesOrEmpty(), input, snapshot.state, snapshot.hits, scope.secrets, scope.env) { r, incoming ->
            route = r
            MockCodec.applyRequest(MockCodec.effective(spec.codec, r.codec)?.request, incoming,
                MockContext(pathParams = MockRuntime.matchPath(r.path, path).orEmpty(), state = snapshot.state, secrets = scope.secrets, json = mapper, env = scope.env), lookup, mapper)
        }.orElseThrow { BadRequestException("UNKNOWN_RULE: 매칭되는 HTTP 라우트·규칙이 없습니다.") }
        val responseSteps = MockCodec.effective(spec.codec, route?.codec)?.response
        val codec = if (responseSteps.isNullOrEmpty()) null else MockRuntime.ResponseCodec { text, outHeaders, contentType ->
            MockCodec.applyResponse(responseSteps, text, outHeaders, contentType, MockContext(req = match.req, pathParams = match.pathParams, seq = snapshot.seq + 1,
                state = snapshot.state, secrets = scope.secrets, json = mapper, env = scope.env), lookup, mapper)
        }
        val out = runtime.render(match.rule, match.req, match.pathParams, snapshot.seq + 1, snapshot.state, codec, scope.secrets, mapper, scope.env)
        val sensitive = SecretMasker.usesSecrets(scope.secrets.values, spec, request, match.req.bodyFields)
        fun shown(value: String) = if (sensitive) "***" else scope.mask(value)
        return mapOf("route" to mapOf("id" to route?.id, "method" to route?.method, "path" to route?.path), "ruleId" to match.rule.id,
            "request" to mapOf("body" to shown(match.req.bodyText), "fields" to match.req.bodyFields.mapValues { shown(it.value) }),
            "response" to mapOf("status" to out.status, "headers" to out.headers.mapValues { shown(it.value) }, "body" to shown(String(out.body, MockHttp.charsetFromContentType(out.contentType))), "wireLength" to out.body.size),
            "callbackPlanned" to (out.callback != null), "pendingState" to out.setState.mapValues { shown(it.value) }, "warnings" to emptyList<String>(), "validations" to listOf(mapOf("valid" to true)))
    }

    private fun previewTcp(spec: MockSpec, scope: MockSecretProvider.Scope, wsId: UUID?, override: JsonNode?, request: JsonNode, virtualSeq: Long): Map<String, Any?> {
        val protocol = previewProtocol(spec, scope, wsId, override) ?: throw BadRequestException("프로토콜을 먼저 고르세요.")
        val plan = ProtocolCompiler.compile(protocol)
        val lookup = scope.codecLookup ?: protocolService.plugins(resourceScope(spec, wsId), resourceIdentity(spec))
        if (request.hasNonNull("bytesB64") && (request.has("key") || request.has("values"))) throw BadRequestException("bytesB64 또는 key/values 중 하나만 사용하세요.")
        val input = if (request.hasNonNull("bytesB64")) {
            val b64 = request.path("bytesB64").asText()
            if (b64.length > ((ProtocolSpec.MAX_MESSAGE + 2) / 3) * 4) throw BadRequestException("bytesB64는 1MB 이하여야 합니다.")
            val bytes = try { java.util.Base64.getDecoder().decode(b64) } catch (_: IllegalArgumentException) { throw BadRequestException("올바른 Base64가 필요합니다.") }
            ProtocolCompiler.parse(protocol, bytes, plugins = lookup, resolve = scope.resolver())
        } else {
            val key = request.path("key").asText().takeIf { it.isNotBlank() } ?: throw BadRequestException("key/values 또는 bytesB64가 필요합니다.")
            val values = request.path("values").fields().asSequence().associate { it.key to it.value.asText() }
            ProtocolCompiler.assemble(protocol, key, values, plugins = lookup, resolve = scope.resolver())
        }
        val transaction = input.transactionKey?.let(plan::transaction)
        val rule = TcpMockRules.match(spec.tcp!!.rulesOrEmpty(), input.values, scope.resolver()) ?: throw BadRequestException("UNKNOWN_RULE: 매칭 TCP 응답 규칙이 없습니다.")
        if (rule.isProxy()) throw BadRequestException("미리보기에서 upstream에 전송하지 않습니다. mock 응답 규칙을 사용하세요.")
        val headerNames = protocol.headerOrEmpty().map { it.nameOrEmpty() }.toSet()
        val fields = TcpMockRules.responseFields(input.values.filterKeys { it in headerNames }, rule.thenFields(),
            MockContext(seq = virtualSeq, secrets = scope.secrets, tcpFields = input.values, env = scope.env), protocol.schemaVersion == 2)
        val responseKey = transaction?.responseMessage ?: protocol.lookup(if (protocol.hasDiscriminator()) fields[protocol.discriminator] else null, Direction.RECV)?.key
            ?: throw BadRequestException("응답 전문 정의가 없습니다.")
        val response = ProtocolCompiler.assemble(protocol, responseKey, fields, transaction?.key, "response", input.values, plugins = lookup, resolve = scope.resolver())
        val secretUsed = SecretMasker.usesSecrets(scope.secrets.values, protocol, spec, request, fields, input.values, response.values)
        fun view(p: ProtocolCompiler.Preview): Map<String, Any?> {
            val safe = if (secretUsed) ByteArray(p.bytes.size) { '*'.code.toByte() } else scope.maskBytes(p.bytes)
            return mapOf("phase" to p.phase, "fields" to p.values.mapValues { if (secretUsed) "***" else scope.mask(it.value) },
                "fieldOffsets" to p.fields.map { it.copy(value = if (secretUsed) "***" else scope.mask(it.value), warn = it.warn?.let { if (secretUsed) SecretMasker.DERIVED_ERROR else scope.mask(it) }) },
                "wireLength" to p.bytes.size, "declaredLength" to p.declaredLength, "lengthAdjustment" to p.lengthAdjustment,
                "text" to TcpBytes.printable(safe, protocol.charset()), "hex" to TcpBytes.hexDump(safe), "bytesB64" to java.util.Base64.getEncoder().encodeToString(safe))
        }
        val phases = mutableListOf<Map<String, Any?>>(mapOf("phase" to "REQUEST", "role" to "mock", "direction" to "RECEIVE", "actualBytes" to input.bytes.size, "status" to "PLANNED"))
        fun ack(phase: String, definition: ProtocolSpec.Ack?) {
            if (definition == null) {
                val legacyHex = if (phase == "requestAck") protocol.transport?.requestAckHex else protocol.transport?.responseAckHex
                val legacy = if (protocol.schemaVersion != 2) legacyHex?.takeIf { it.isNotBlank() }?.let(TcpBytes::hexToBytes) else null
                phases += mapOf("phase" to if (phase == "requestAck") "REQUEST_ACK" else "RESPONSE_ACK",
                    "role" to "mock", "direction" to if (phase == "requestAck") "SEND" else "RECEIVE", "expectedBytes" to legacy?.size,
                    "validationMode" to if (legacy == null) null else "exact", "status" to if (legacy == null) "SKIPPED" else "PLANNED")
            }
            else {
                val generated = ProtocolCompiler.assemble(protocol, transactionKey = transaction!!.key, phase = phase, requestFields = input.values,
                    responseFields = response.values, plugins = lookup, resolve = scope.resolver())
                phases += mapOf("phase" to if (phase == "requestAck") "REQUEST_ACK" else "RESPONSE_ACK", "role" to "mock",
                    "direction" to if (phase == "requestAck") "SEND" else "RECEIVE", "expectedBytes" to generated.bytes.size,
                    "validationMode" to definition.receive?.kind, "status" to "PLANNED", "preview" to view(generated))
            }
        }
        ack("requestAck", transaction?.requestAck)
        phases += mapOf("phase" to "RESPONSE", "role" to "mock", "direction" to "SEND", "actualBytes" to response.bytes.size, "status" to "PLANNED")
        ack("responseAck", transaction?.responseAck)
        return mapOf("transactionKey" to transaction?.key, "ruleId" to rule.id, "conditions" to rule.whenOrEmpty().map { mapOf("field" to it.field, "op" to it.op, "matched" to true) },
            "request" to view(input), "response" to view(response), "steps" to phases, "requiredCapabilities" to plan.requiredCapabilities,
            "compiledSummary" to plan.summary, "warnings" to if (secretUsed) emptyList<String>() else (input.warnings + response.warnings).map(scope::mask), "validations" to listOf(mapOf("valid" to true)))
    }

    @Transactional(readOnly = true)
    fun list(workspaceIdRaw: String? = null): List<MockServerSummary> {
        val wsId = workspace.resolveId(workspaceIdRaw)
        workspace.requireRead(workspace.currentUsername(), wsId)
        val names = protocolNames()
        return repository.findByTenantIdOrderByUpdatedAtDesc(tenant())
            .filter { it.workspaceId == wsId }
            .map { toSummary(it, names) }
    }

    /**
     * 서버 현황(fleet) — **모든 워크스페이스**의 Mock 을 워크스페이스·포트와 함께 한 번에.
     * 접근 권한이 없는 워크스페이스의 Mock 도 "무엇이 떠 있는지"(이름·종류·켜짐·포트·살아있음)는 보이고 정의 내용은 비운다 —
     * 서빙 주소(/mock/{slug})와 TCP 포트는 전역 자원이라 충돌·점유를 누구나 알 수 있어야 한다(내용은 여전히 roleFor 게이트).
     * 그룹핑용 mine 은 멤버십 기준(관리자 OWNER 우회와 별개) — "내 워크스페이스가 아니면 읽기 전용" 표시의 근거.
     */
    @Transactional(readOnly = true)
    fun fleet(): MockDtos.MockFleet {
        val me = workspace.currentUsername()
        val roles = HashMap<UUID?, String?>()
        fun role(ws: UUID?): String? = roles.getOrPut(ws) { workspace.roleFor(me, ws) }
        val wsViews = ArrayList<MockDtos.FleetWorkspace>()
        if (!workspace.localRuntime) wsViews.add(MockDtos.FleetWorkspace(com.flowlink.workspace.WorkspaceService.PUBLIC_ID, "공용", "PUBLIC", role(null), mine = true))
        for (ws in workspace.listAll()) {
            val mine = if (ws.kind == com.flowlink.core.domain.Workspace.KIND_PERSONAL) ws.ownerUsername == me else workspace.isMember(me, ws.id)
            wsViews.add(MockDtos.FleetWorkspace(ws.id.toString(), ws.name, ws.kind, role(ws.id), mine, ws.ownerUsername))
        }
        val index = usageIndex()
        val names = protocolNames()
        val canRead: (UUID?) -> Boolean = { ws -> role(ws) != null }
        val servers = repository.findByTenantIdOrderByUpdatedAtDesc(tenant()).filter { workspace.supportsWorkspace(it.workspaceId) }.map { m ->
            val r = role(m.workspaceId)
            val readable = r != null
            val s = toSummary(m, names)
            val listeningPort = tcpRegistry.listeningPort(m.id)
            // 프로토콜을 안 골랐으면 리스너를 열지 않는 게 정상(TcpMockRegistry.sync) — OFF 로 보여야 한다.
            // 프로토콜 id 가 있는데 그 프로토콜이 삭제된 경우는 여전히 FAILED(이름이 아니라 id 로 판정).
            val shouldListen = m.isEnabled && s.tcpPort != null && s.tcpEnabled != false && !digest(m).protocolId.isNullOrBlank()
            MockDtos.FleetServer(
                m.id, m.name, m.slug, m.kind.name, m.isEnabled, m.workspaceId?.toString() ?: com.flowlink.workspace.WorkspaceService.PUBLIC_ID, readable, r,
                s.tcpPort, s.tcpEnabled, listeningPort != null,
                if (shouldListen && listeningPort == null) (tcpRegistry.bindFailure(m.id) ?: "리스너가 열려 있지 않습니다") else null,
                s.routeCount, if (readable) s.routeLabels else emptyList(), s.tcpRuleCount,
                if (readable) s.protocolName else null, if (readable) s.upstream else null, s.hasCodec, if (readable) s.environment else null,
                s.lastRequestAt, s.recentRequests, s.requestCount, s.unmatchedRequests, s.currentVersion, m.updatedAt,
                basePath(m), listener(m), if (readable) usedBy(m, index, canRead) else emptyList(),
            )
        }
        val httpPort = env.getProperty("local.server.port")?.toIntOrNull()?.takeIf { it > 0 } ?: env.getProperty("server.port")?.toIntOrNull()?.takeIf { it > 0 } ?: 18080
        val contextPath = env.getProperty("server.servlet.context-path") ?: ""
        val ports = ArrayList<MockDtos.FleetPort>()
        ports.add(MockDtos.FleetPort(httpPort, "HTTP", "LISTENING", count = servers.count { it.kind != "TCP" && it.enabled }))
        for (s in servers) {
            val p = s.tcpPort ?: continue
            val state = when {
                s.listening -> "LISTENING"
                s.listenError != null -> "FAILED"
                else -> "OFF"
            }
            ports.add(MockDtos.FleetPort(p, "TCP", state, s.id, s.name, s.slug, s.workspaceId, s.readable, 1, s.listenError))
        }
        ports.sortWith(compareBy({ it.kind != "HTTP" }, { it.port }, { it.mockName ?: "" })) // HTTP 게이트웨이 먼저, TCP 는 포트순
        return MockDtos.MockFleet(wsViews, servers, ports, httpPort, contextPath, Instant.now())
    }

    /**
     * 이 워크스페이스 Mock 들을 호출하는 워크플로 — 읽을 수 있는 워크플로의 **현재 그래프**에 `/mock/{slug}` 가 있으면 사용처.
     * 그래프 전량 스캔이라 테넌트 단위 30초 캐시(목록 새로고침마다 도는 비용 방지). 결과: mockId → [flow].
     */
    @Transactional(readOnly = true)
    fun usages(workspaceIdRaw: String? = null): Map<UUID, List<MockDtos.FlowRef>> {
        val wsId = workspace.resolveId(workspaceIdRaw)
        val me = workspace.currentUsername()
        workspace.requireRead(me, wsId)
        val mocks = repository.findByTenantIdOrderByUpdatedAtDesc(tenant()).filter { it.workspaceId == wsId }
        if (mocks.isEmpty()) return emptyMap()
        val index = usageIndex()
        val readable = HashMap<UUID?, Boolean>()
        fun canRead(ws: UUID?): Boolean = readable.getOrPut(ws) { try { workspace.requireRead(me, ws); true } catch (e: Exception) { false } }
        val out = LinkedHashMap<UUID, List<MockDtos.FlowRef>>()
        for (m in mocks) {
            val refs = usedBy(m, index, ::canRead)
            if (refs.isNotEmpty()) out[m.id] = refs
        }
        return out
    }

    /** 사용처 인덱스(플로우 → 현재 그래프 JSON) — 테넌트별 30초 캐시. */
    private fun usageIndex(): List<Pair<com.flowlink.core.domain.Flow, String>> {
        val t = tenant()
        val now = System.currentTimeMillis()
        val cached = usageCache[t]
        if (cached != null && now - cached.first < USAGE_TTL_MS) return cached.second
        val flows = flowRepo.findByTenantIdAndArchivedFalseOrderByUpdatedAtDesc(t)
        val graphs = if (flows.isEmpty()) emptyMap() else flowVersionRepo.findCurrentByFlowIds(flows.map { it.id }).associateBy { it.flowId }
        val built = flows.mapNotNull { f -> graphs[f.id]?.graphJson?.let { g -> f to g } }
        usageCache[t] = now to built
        return built
    }

    /** slug 의 서빙 경로(`/mock/{slug}` 경계)를 현재 그래프에 가진, 읽을 수 있는 워크플로. */
    private fun usedBy(mock: MockServer, index: List<Pair<com.flowlink.core.domain.Flow, String>>, canRead: (UUID?) -> Boolean): List<MockDtos.FlowRef> {
        val prefixes = mutableListOf(Regex.escape(basePath(mock)))
        if (mock.workspaceId == null || workspace.localRuntime) {
            prefixes.add(Regex.escape("/mock/${mock.slug}"))
            prefixes.add(Regex.escape("/mock/${mock.tenantId}/${mock.slug}"))
        }
        val re = Regex("(?:" + prefixes.joinToString("|") + ")(?=[/\"?\\s]|$)")
        return index.filter { (f, g) -> canRead(f.workspaceId) && re.containsMatchIn(g) }.map { (f, _) -> MockDtos.FlowRef(f.id, f.name) }
    }

    @Transactional
    fun create(req: CreateMockServerRequest): MockServerDetail {
        val wsId = workspace.resolveId(req.workspaceId)
        workspace.requireWrite(workspace.currentUsername(), wsId)
        val slug = req.slug.lowercase(Locale.ROOT)
        if (!SLUG.matcher(slug).matches()) {
            throw BadRequestException("slug 는 소문자·숫자·하이픈 3~40자여야 합니다: $slug")
        }
        if (repository.existsByTenantIdAndWorkspaceKeyAndSlug(tenant(), resourceWorkspace.key(wsId), slug)) {
            throw BadRequestException("이 워크스페이스에서 이미 사용 중인 slug 입니다: $slug")
        }
        // 유형 선택 — TCP 면 tcp 섹션만, 그 외(기본)는 HTTP 라우트만. CUSTOM(둘 다)은 레거시 데이터 전용.
        val kind = if (req.type?.uppercase(Locale.ROOT) == "TCP") MockServer.Kind.TCP else MockServer.Kind.HTTP
        val spec = if (kind == MockServer.Kind.TCP) defaultTcpSpec(tcpRegistry.pickFreePort()) else defaultCustomSpec()
        // saveAndFlush: 신규 엔티티라 @CreationTimestamp lateinit createdAt/updatedAt 가 flush 후 채워진다
        // (toDetail 이 이를 읽으므로 flush 전 접근하면 UninitializedPropertyAccessException). FlowService.createInternal 과 동일.
        val entity = MockServer.create(tenant(), req.name, slug, kind, spec)
        entity.workspaceId = wsId
        val saved = repository.saveAndFlush(entity)
        snapshot(saved, "생성", pinned = false) // v1 = 초기 정의
        tcpRegistry.sync(saved) // TCP 면 pickFreePort 로 고른 빈 포트에 바인딩(충돌 없음)
        usageCache.clear()
        return toDetail(saved)
    }

    @Transactional(readOnly = true)
    fun get(id: UUID): MockServerDetail = toDetail(findReadable(id))

    @Transactional
    fun updateMeta(id: UUID, req: UpdateMockServerRequest): MockServerDetail {
        val m = find(id)
        val before = toDetail(m)
        if (req.name != null && req.name.isNotBlank()) {
            m.name = req.name
        }
        if (req.enabled != null) {
            if (req.enabled) validateTcp(parseSpec(m.specJson), m.workspaceId)
            m.isEnabled = req.enabled
        }
        if (req.workspaceId != null) {
            // 워크스페이스 이동 — 대상에도 쓰기 권한. slug 는 테넌트 전역 유니크라 충돌 없음.
            val target = workspace.resolveId(req.workspaceId)
            if (target != m.workspaceId) {
                workspace.requireWrite(workspace.currentUsername(), target)
                if (repository.existsByTenantIdAndWorkspaceKeyAndSlug(tenant(), resourceWorkspace.key(target), m.slug)) throw BadRequestException("대상 워크스페이스에 같은 slug가 있습니다: ${m.slug}")
                m.workspaceId = target
                validateTcp(parseSpec(m.specJson), target)
                usageCache.clear()
            }
        }
        val saved = repository.save(m)
        activate(saved, before)
        return toDetail(saved)
    }

    @Transactional
    fun updateSpec(id: UUID, spec: JsonNode?, note: String? = null, pinned: Boolean = false): MockServerDetail {
        val m = find(id)
        val before = toDetail(m)
        if (spec == null || spec.isNull) {
            throw BadRequestException("spec 이 없습니다.")
        }
        val stored = normalizeResourceSpec(spec)
        val raw = stored.toString()
        // 저장 전 파싱 + TCP 규칙 검증 — 깨진 spec 이 게이트웨이에서 500 을 만들거나, 절대 응답 못 하는 규칙이 저장되지 않게 한다
        validateTcp(parseSpec(raw), m.workspaceId)
        // 구조 비교 — 저장된 spec 이 pretty-print(생성 기본값/복원)라도 내용이 같으면 스냅샷을 만들지 않는다
        val changed = try { json.readTree(raw) != json.readTree(m.specJson ?: "{}") } catch (e: Exception) { true }
        m.specJson = raw
        val saved = repository.save(m)
        // 내용이 바뀌었거나 📌 보존 요청이면 스냅샷(같은 내용 재저장은 버전 낭비 방지)
        if (changed || pinned || !note.isNullOrBlank()) snapshot(saved, note?.trim()?.takeIf { it.isNotEmpty() }, pinned)
        activate(saved, before)
        digestCache.remove(m.id)
        return toDetail(saved)
    }

    private fun activate(saved: MockServer, before: MockServerDetail) {
        try { tcpRegistry.sync(saved) } catch (e: BadRequestException) {
            throw MockActivationException(if (e.message?.contains("포트") == true) "PORT_IN_USE" else "ACTIVATION_FAILED",
                mapOf("id" to before.id, "currentVersion" to before.currentVersion, "enabled" to before.enabled,
                    "listener" to before.listener, "actualListeningPort" to tcpRegistry.listeningPort(before.id),
                    "definitionPreserved" to true, "listenerPreserved" to (tcpRegistry.listeningPort(before.id) != null)))
        }
    }

    @Transactional
    fun delete(id: UUID) {
        val m = find(id)
        versionRepo.deleteByMockServerId(m.id)
        repository.delete(m)
        tcpRegistry.stop(m.id)
        store.forget(m.id)
        digestCache.remove(m.id)
        usageCache.clear()
    }

    // ---------- 버전 기록(정의 스냅샷) ----------

    /** 스냅샷 1개 추가 + 정리(mock 당 최근 VERSIONS_KEEP 개 유지, 📌 제외). */
    private fun snapshot(m: MockServer, note: String?, pinned: Boolean): com.flowlink.core.domain.MockServerVersion {
        val next = m.currentVersionOrZero() + 1
        val v = com.flowlink.core.domain.MockServerVersion.create(m.id, next, m.specJson ?: "{}", note, workspace.currentUsername())
        if (pinned) v.pinned = true
        val saved = versionRepo.saveAndFlush(v)
        m.currentVersion = next
        repository.save(m)
        for (old in versionRepo.findPrunable(m.id, next - VERSIONS_KEEP + 1)) versionRepo.delete(old)
        return saved
    }

    @Transactional(readOnly = true)
    fun listVersions(id: UUID): List<MockDtos.MockVersionSummary> {
        findReadable(id)
        return versionRepo.findByMockServerIdOrderByVersionNoDesc(id).map { toVersionSummary(it) }
    }

    @Transactional(readOnly = true)
    fun getVersionSpec(id: UUID, versionNo: Int): JsonNode {
        findReadable(id)
        val v = versionRepo.findByMockServerIdAndVersionNo(id, versionNo).orElseThrow { NotFoundException("버전이 없습니다: v$versionNo") }
        return json.readTree(v.specJson)
    }

    /** 과거 스냅샷을 **새 버전으로** 복원(이력 보존) + 서빙 즉시 반영. */
    @Transactional
    fun restoreVersion(id: UUID, versionNo: Int): MockDtos.MockVersionSummary {
        val m = find(id)
        val src = versionRepo.findByMockServerIdAndVersionNo(id, versionNo).orElseThrow { NotFoundException("버전이 없습니다: v$versionNo") }
        validateTcp(parseSpec(src.specJson), m.workspaceId)
        m.specJson = src.specJson
        val saved = repository.save(m)
        val v = snapshot(saved, "v$versionNo 복원", pinned = false)
        tcpRegistry.sync(saved)
        digestCache.remove(m.id)
        return toVersionSummary(v)
    }

    @Transactional
    fun setVersionPinned(id: UUID, versionNo: Int, pinned: Boolean): MockDtos.MockVersionSummary {
        find(id)
        val v = versionRepo.findByMockServerIdAndVersionNo(id, versionNo).orElseThrow { NotFoundException("버전이 없습니다: v$versionNo") }
        v.pinned = pinned
        return toVersionSummary(versionRepo.saveAndFlush(v))
    }

    private fun toVersionSummary(v: com.flowlink.core.domain.MockServerVersion): MockDtos.MockVersionSummary {
        val d = digestOf(v.specJson)
        return MockDtos.MockVersionSummary(v.id, v.versionNo, v.note, v.createdBy, v.createdAt, v.pinned == true, d.routeCount, d.tcpPort)
    }

    /** 요청 기록(journal, 최신순) — 테넌트 소유 확인 후. */
    @Transactional(readOnly = true)
    /**
     * 코덱 시험(HTTP) — 샘플 전문(+헤더)에 미저장 코덱을 적용해 단계별 입력/출력을 돌려준다.
     * 시크릿 값이 실제로 쓰이므로 승인 사용자만(시크릿 쓰기와 같은 게이트) + 대상 Mock 읽기 권한. 결과의 시크릿 값은 마스킹.
     */
    fun tryCodec(id: UUID, req: MockDtos.CodecTryRequest): MockDtos.CodecTryResult {
        val mock = findReadable(id)
        val savedSpec = parseSpec(mock.specJson)
        if (workspace.localRuntime && savedSpec.resourceWorkspaceId != "public") throw com.flowlink.common.error.ForbiddenException("플러그인은 공용·팀 워크스페이스에서만 사용할 수 있습니다.")
        if (!workspace.isApproved(workspace.currentUsername())) throw com.flowlink.common.error.ForbiddenException("코덱 시험은 가입 승인 후 가능합니다(시크릿 값 사용).")
        val codec = req.codec ?: throw BadRequestException("codec 이 없습니다.")
        val side = (req.side ?: "request").lowercase(Locale.ROOT)
        val trialSpec = savedSpec.copy(codec = codec, environment = req.environment)
        val scope = secretProvider.scope(tenant(), req.environment, cached = false, workspaceId = mock.workspaceId, spec = trialSpec)
        val secrets = scope.secrets
        val mapper = json.mapper()
        val lookup: (String) -> com.flowlink.transform.FlowTransform? = scope.transformLookup ?: { transforms.get(it, resourceScope(savedSpec, mock.workspaceId)).orElse(null) }
        val traces = ArrayList<MockCodec.StepTrace>()
        val headersIn = LinkedHashMap<String, String>()
        for ((k, v) in req.headers ?: emptyMap()) headersIn[k.lowercase(Locale.ROOT)] = v
        val ct = req.contentType?.takeIf { it.isNotBlank() } ?: headersIn["content-type"] ?: "application/json"
        val message = req.message ?: ""
        val masks = com.flowlink.execution.engine.SecretMasker.variants(secrets.values)
        fun m(s: String) = com.flowlink.execution.engine.SecretMasker.mask(s, masks) ?: s
        try {
            if (side == "response") {
                val ctx = MockContext(req = MockHttp.MockRequest("POST", "/", emptyMap(), headersIn, "", emptyMap()), seq = 1001L, secrets = secrets, json = mapper, env = scope.env)
                val headers = LinkedHashMap<String, String>()
                val out = MockCodec.applyResponse(codec.response, message, headers, ct, ctx, lookup, mapper, traces)
                return MockDtos.CodecTryResult(m(out), headers.mapValues { m(it.value) }, emptyMap(), traces.map { it.copy(input = m(it.input), output = m(it.output)) })
            }
            val cs = MockHttp.charsetFromContentType(ct)
            if (!headersIn.containsKey("content-type")) headersIn["content-type"] = ct
            val request = MockHttp.MockRequest("POST", "/", emptyMap(), headersIn, message, MockHttp.parseBodyFields(message, ct, cs, mapper))
            val ctx = MockContext(seq = 1001L, secrets = secrets, json = mapper, env = scope.env)
            val out = MockCodec.applyRequest(codec.request, request, ctx, lookup, mapper, traces)
            return MockDtos.CodecTryResult(m(out.bodyText), out.headers.mapValues { m(it.value) }, out.bodyFields.mapValues { m(it.value) }, traces.map { it.copy(input = m(it.input), output = m(it.output)) })
        } catch (e: MockCodec.CodecException) {
            throw BadRequestException(m(e.message ?: "코덱 실패"))
        }
    }

    fun requests(id: UUID): List<MockDtos.MockRequestLog> {
        findReadable(id)
        return store.journal(id).map {
            MockDtos.MockRequestLog(it.at, it.method, it.path, it.query, it.headers, it.bodyText, it.matchedRuleId, it.status, it.delayMs, it.callbackFired, it.decodedBody)
        }
    }

    @Transactional
    fun clearRequests(id: UUID) { find(id); store.clearJournal(id) } // 런타임 변형 = 쓰기 게이트

    /** 런타임 상태 초기화(state·seq·hits·journal) — 재시작 없이 깨끗한 상태로. */
    @Transactional
    fun reset(id: UUID) { find(id); store.reset(id) }

    /** 현재 런타임 상태 스냅샷(state·seq·hits·요청수). */
    @Transactional(readOnly = true)
    fun runtimeState(id: UUID): MockDtos.MockStateView {
        findReadable(id)
        val s = store.snapshot(id)
        return MockDtos.MockStateView(s.state, s.seq, s.hits, s.requestCount)
    }

    /** slug 사용 가능 여부 — 생성 폼의 실시간 체크(서빙 경로가 전역이라 워크스페이스 무관 전체 유일). */
    @Transactional(readOnly = true)
    fun slugAvailable(slugRaw: String, workspaceId: String? = null): Boolean {
        val scope = resourceWorkspace.read(workspaceId)
        val slug = slugRaw.lowercase(Locale.ROOT)
        if (!SLUG.matcher(slug).matches()) return false
        return !repository.existsByTenantIdAndWorkspaceKeyAndSlug(tenant(), scope, slug)
    }

    /** 게이트웨이 서빙용 — 무인증. tenant 는 경로 세그먼트에서 온다(레거시 경로는 default 테넌트). */
    @Transactional(readOnly = true)
    fun findForServing(tenantId: String, slug: String): Optional<MockServer> =
        repository.findByTenantIdAndWorkspaceKeyAndSlug(tenantId, resourceWorkspace.key(), slug).filter { it.isEnabled && workspace.supportsWorkspace(it.workspaceId) }

    @Transactional(readOnly = true)
    fun findForServingWorkspace(workspaceKey: String, slug: String): Optional<MockServer> {
        val id = try { com.flowlink.workspace.ResourceWorkspace.id(workspaceKey) } catch (_: IllegalArgumentException) { return Optional.empty() }
        if (!workspace.supportsWorkspace(id)) return Optional.empty()
        return repository.findByTenantIdAndWorkspaceKeyAndSlug(tenant(), workspaceKey, slug).filter { it.isEnabled }
    }

    fun basePath(m: MockServer): String = "/mock/ws/${m.workspaceId?.toString() ?: "public"}/${m.slug}"

    data class AgentMockTarget(val baseUrl: String, val tcpHost: String?, val tcpPort: Int?)

    /** 불변 구 버전의 자기 서버 Mock URL만 현재 실행 공간의 namespace로 해석한다. */
    @Transactional(readOnly = true)
    fun normalizeLegacyUrl(url: String, workspaceId: UUID? = null): String {
        val uri = runCatching { java.net.URI(url) }.getOrNull() ?: return url
        if (uri.scheme !in setOf("http", "https") || uri.host == null || uri.rawUserInfo != null) return url
        fun port(u: java.net.URI) = if (u.port >= 0) u.port else if (u.scheme == "https") 443 else 80
        val context = env.getProperty("server.servlet.context-path").orEmpty().trimEnd('/')
        val localPort = (env.getProperty("local.server.port") ?: env.getProperty("server.port"))?.toIntOrNull() ?: 18080
        val configured = env.getProperty("flowlink.runtime.public-url")?.takeIf { it.isNotBlank() }
            ?.let { runCatching { java.net.URI(it) }.getOrNull() }
        val prefix = when {
            uri.host.lowercase() in setOf("localhost", "127.0.0.1", "::1", "[::1]") && port(uri) == localPort -> context
            configured?.host != null && uri.scheme == configured.scheme && uri.host.equals(configured.host, true) && port(uri) == port(configured) -> configured.path.orEmpty().trimEnd('/')
            else -> return url
        }
        val marker = "$prefix/mock/"
        val path = uri.rawPath ?: return url
        if (!path.startsWith(marker) || path.startsWith(marker + "ws/")) return url
        val scope = resourceWorkspace.key(workspaceId)
        val localPath = path.removePrefix(prefix)
        val resolved = MockPathResolver.resolve(localPath) { requestedTenant, slug ->
            if (requestedTenant != tenant()) null
            else repository.findByTenantIdAndWorkspaceKeyAndSlug(tenant(), scope, slug).orElse(null)
        } ?: return url
        val rewritten = prefix + basePath(resolved.server) + localPath.removePrefix(resolved.pathPrefix)
        return uri.scheme + "://" + uri.rawAuthority + rewritten +
            (uri.rawQuery?.let { "?$it" } ?: "") + (uri.rawFragment?.let { "#$it" } ?: "")
    }

    @Transactional(readOnly = true)
    fun resolveAgentTarget(slug: String, workspaceId: UUID? = null): AgentMockTarget {
        val scope = resourceWorkspace.key(workspaceId)
        val m = repository.findByTenantIdAndWorkspaceKeyAndSlug(tenant(), scope, slug).orElseThrow { NotFoundException("이 워크스페이스에 Mock이 없습니다: $slug") }
        if (!m.isEnabled) throw BadRequestException("Mock이 중지되어 있습니다: $slug")
        val port = tcpRegistry.listeningPort(m.id)
        if (m.kind == MockServer.Kind.TCP && port == null) throw BadRequestException(tcpRegistry.bindFailure(m.id) ?: "TCP Mock 리스너가 열려 있지 않습니다: $slug")
        val httpPort = env.getProperty("local.server.port") ?: env.getProperty("server.port") ?: "18080"
        val context = env.getProperty("server.servlet.context-path").orEmpty().trimEnd('/')
        return AgentMockTarget("http://127.0.0.1:$httpPort$context${basePath(m)}", if (port == null) null else "127.0.0.1", port)
    }

    private fun listener(m: MockServer): MockDtos.ListenerView {
        val tcp = parseSpec(m.specJson).tcp
        val isTcp = m.kind == MockServer.Kind.TCP || tcp != null
        val port = if (isTcp) tcp?.port else (env.getProperty("local.server.port") ?: env.getProperty("server.port"))?.toIntOrNull() ?: 18080
        val bound = if (isTcp) tcpRegistry.listeningPort(m.id) != null else m.isEnabled && workspace.supportsWorkspace(m.workspaceId)
        val failure = if (m.isEnabled && isTcp && !tcp?.protocolId.isNullOrBlank() && !bound) tcpRegistry.bindFailure(m.id) ?: "리스너가 열려 있지 않습니다" else null
        val bind = if (workspace.localRuntime) "127.0.0.1" else env.getProperty("server.address", "0.0.0.0")
        val publicBase = env.getProperty("flowlink.runtime.public-url").orEmpty().trimEnd('/').ifBlank { "http://127.0.0.1:${env.getProperty("local.server.port") ?: env.getProperty("server.port") ?: "18080"}${env.getProperty("server.servlet.context-path").orEmpty()}" }
        val advertised = if (isTcp) "${if (workspace.localRuntime) "127.0.0.1" else env.getProperty("flowlink.mock.tcp.advertised-host").orEmpty().ifBlank { runCatching { java.net.URI(publicBase).host }.getOrNull() ?: "127.0.0.1" }}:$port" else publicBase + basePath(m)
        return MockDtos.ListenerView(if (workspace.localRuntime) "local" else "server", if (isTcp) "$bind:$port" else "$bind:$port${basePath(m)}", advertised,
            if (bound) "LISTENING" else if (failure != null) "FAILED" else "OFF", failure)
    }

    fun parseSpec(specJson: String?): MockSpec {
        if (specJson == null || specJson.isBlank()) {
            return MockSpec(emptyList())
        }
        return try {
            val spec = json.mapper().readValue(specJson, MockSpec::class.java)
            spec ?: MockSpec(emptyList())
        } catch (e: Exception) {
            throw BadRequestException("mock spec JSON 파싱 실패: " + e.message)
        }
    }

    private fun normalizeResourceSpec(source: JsonNode): JsonNode {
        val spec = parseSpec(source.toString())
        if (spec.resourceWorkspaceId == null) return source
        if (spec.resourceWorkspaceId != "public") throw BadRequestException("공통 자원 공간은 public만 선택할 수 있습니다.")
        if (spec.envSource != null && spec.envSource !in setOf("local", "server")) throw BadRequestException("알 수 없는 환경 출처입니다.")
        if (!workspace.localRuntime && spec.envSource == "local") throw BadRequestException("서버 Mock에서는 내 PC 환경을 사용할 수 없습니다.")
        val copy = source.deepCopy<com.fasterxml.jackson.databind.node.ObjectNode>()
        if (workspace.localRuntime) {
            val active = connection?.getObject()?.connectionIdentity() ?: throw BadRequestException("PC 서버 연결 정보가 준비되지 않았습니다.")
            copy.set<JsonNode>("resourceIdentity", json.mapper().valueToTree(com.flowlink.agent.CentralResourceIdentity(active.serverUrl, active.login)))
            if (spec.envSource == null) copy.put("envSource", "local")
        } else {
            copy.remove("resourceIdentity")
            if (spec.envSource == null) copy.put("envSource", "server")
        }
        return copy
    }

    private fun resourceScope(spec: MockSpec, owner: UUID?): UUID? = if (spec.resourceWorkspaceId == "public") null else owner
    private fun resourceIdentity(spec: MockSpec): com.flowlink.agent.CentralResourceIdentity? = if (workspace.localRuntime && spec.resourceWorkspaceId == "public")
        spec.resourceIdentity?.takeIf { it.serverUrl.isNotBlank() } ?: throw BadRequestException("Mock을 저장한 서버 연결 정보가 필요합니다.") else null

    /** 쓰기 경로 로드 — 워크스페이스 EDITOR 이상(VIEWER 는 조회만). */
    private fun find(id: UUID): MockServer {
        val m = repository.findByIdAndTenantId(id, tenant())
            .orElseThrow { NotFoundException("Mock 서버가 없습니다: $id") }
        workspace.requireWrite(workspace.currentUsername(), m.workspaceId)
        return m
    }

    /** 읽기 경로 로드 — 워크스페이스 읽기 권한. */
    private fun findReadable(id: UUID): MockServer {
        val m = repository.findByIdAndTenantId(id, tenant())
            .orElseThrow { NotFoundException("Mock 서버가 없습니다: $id") }
        workspace.requireRead(workspace.currentUsername(), m.workspaceId)
        return m
    }

    /** spec 요약(라우트 수/메서드/경로/TCP/코덱) — updatedAt 키 캐시(spec 은 저장 때만 바뀜). */
    private data class SpecDigest(val routeCount: Int, val methods: List<String>, val paths: List<String>, val tcpPort: Int?, val tcpEnabled: Boolean?, val hasCodec: Boolean, val environment: String?, val tcpRuleCount: Int = 0, val protocolId: String? = null, val upstream: String? = null, val routeLabels: List<String> = emptyList())
    private val digestCache = java.util.concurrent.ConcurrentHashMap<UUID, Pair<Instant, SpecDigest>>()
    /** 사용처 인덱스(플로우 현재 그래프) — 테넌트별 30초 캐시. */
    private val usageCache = java.util.concurrent.ConcurrentHashMap<String, Pair<Long, List<Pair<com.flowlink.core.domain.Flow, String>>>>()

    private fun digestOf(specJson: String?): SpecDigest {
        val spec = try { parseSpec(specJson) } catch (e: Exception) { return SpecDigest(0, emptyList(), emptyList(), null, null, false, null) }
        val routes = spec.routesOrEmpty()
        val methods = routes.mapNotNull { it.method?.uppercase(Locale.ROOT) }.distinct().take(6)
        val paths = routes.mapNotNull { it.path }.take(6)
        val hasCodec = spec.codec?.let { !(it.request.isNullOrEmpty() && it.response.isNullOrEmpty()) } == true || routes.any { it.codec != null }
        val labels = routes.take(8).map { "${it.method?.uppercase(Locale.ROOT) ?: "ANY"} ${it.path ?: "/"}" }
        return SpecDigest(routes.size, methods, paths, spec.tcp?.port, spec.tcp?.let { true }, hasCodec, spec.environment?.takeIf { it.isNotBlank() },
            spec.tcp?.rulesOrEmpty()?.size ?: 0, spec.tcp?.protocolId?.trim()?.takeIf { it.isNotEmpty() }, spec.tcp?.upstream?.trim()?.takeIf { it.isNotEmpty() }, labels)
    }

    /** 프로토콜 id → 이름(테넌트 1회 조회) — 목록/현황이 TCP Mock 마다 조회하지 않게. */
    private fun protocolNames(): Map<String, String> =
        protocolRepo.findByTenantIdOrderByNameAsc(tenant()).associate { it.id.toString() to it.name }

    /** spec 요약 — updatedAt 키 캐시(spec 은 저장 때만 바뀐다). */
    private fun digest(m: MockServer): SpecDigest {
        val hit = digestCache[m.id]
        return if (hit != null && hit.first == m.updatedAt) hit.second
        else digestOf(m.specJson).also { digestCache[m.id] = m.updatedAt to it }
    }

    private fun toSummary(m: MockServer, protocolNames: Map<String, String> = emptyMap()): MockServerSummary {
        val d = digest(m)
        val now = Instant.now()
        // 살아있음 지표: TCP 는 전문 로그(수신분), HTTP 는 요청 기록(journal)
        val last: Instant?; val recent: Int; val count: Int; val unmatched: Int
        if (d.tcpEnabled == true) {
            val log = store.tcpLog(m.id).filter { it.dir == "in" }
            last = log.firstOrNull()?.at; recent = log.count { java.time.Duration.between(it.at, now).seconds <= 60 }
            count = log.size; unmatched = log.count { it.source == "none" }
        } else {
            val journal = store.journal(m.id)
            last = journal.firstOrNull()?.at; recent = journal.count { java.time.Duration.between(it.at, now).seconds <= 60 }
            count = journal.size; unmatched = journal.count { it.matchedRuleId == null }
        }
        return MockServerSummary(
            m.id, m.name, m.slug, m.kind.name, m.isEnabled, m.updatedAt, m.workspaceId,
            d.routeCount, d.methods, d.paths, d.tcpPort, d.tcpEnabled, d.routeLabels, d.tcpRuleCount,
            d.protocolId?.let { protocolNames[it] }, d.upstream, d.hasCodec, d.environment,
            last, recent, count, unmatched, m.currentVersionOrZero(), basePath(m), listener(m),
        )
    }

    private fun toDetail(m: MockServer): MockServerDetail {
        val specJson = m.specJson
        val spec: JsonNode = if (specJson == null || specJson.isBlank()) {
            json.mapper().createObjectNode()
        } else {
            json.readTree(specJson)
        }
        return MockServerDetail(
            m.id, m.name, m.slug, m.kind.name,
            m.isEnabled, spec, m.createdAt, m.updatedAt, m.workspaceId, m.currentVersionOrZero(), basePath(m), listener(m)
        )
    }

    /** 새 HTTP 서버의 시작 예시 — 편집기에서 바로 고쳐 쓰는 안내 겸용. */
    private fun defaultCustomSpec(): String = """
        {"routes":[{"id":"r1","method":"GET","path":"/hello","rules":[
          {"id":"u1","status":200,"contentType":"json",
           "body":"{\"message\":\"안녕하세요 {{query.name}}\",\"seq\":\"{{seq}}\"}"}
        ]}]}""".trimIndent()

    /** 새 TCP 서버의 시작 예시 — 빈 포트만 잡아 둔다(프로토콜·규칙은 편집기에서 고른다). */
    private fun defaultTcpSpec(port: Int): String =
        """{"tcp":{"port":$port,"protocolId":null,"upstream":null,"timeoutMs":5000,"rules":[]}}"""

    // ---------- TCP 트래픽(전문 로그) / 보내보기 ----------

    /** 이 Mock 이 주고받은 전문 로그(최신순) — 읽기 권한. */
    @Transactional(readOnly = true)
    fun tcpLog(id: UUID): List<MockRuntimeStore.TcpLogEntry> = findReadable(id).let { store.tcpLog(id) }

    @Transactional
    fun clearTcpLog(id: UUID) { find(id); store.clearTcpLog(id) } // 런타임 변형 = 쓰기 게이트

    @Transactional(readOnly = true)
    fun tcpSessions(id: UUID): List<TcpMockListenerRuntime.SessionView> {
        val m = findReadable(id)
        if (parseSpec(m.specJson).tcp == null) throw BadRequestException("TCP Mock이 아닙니다.")
        return tcpRegistry.sessions(id)
    }

    /** 정의를 저장하거나 소켓에 전문을 보내지 않고, 선택한 수신 연결의 대기 기한만 연장한다. */
    fun extendTcpSession(id: UUID, sessionId: UUID, extendMs: Int): TcpMockListenerRuntime.SessionView {
        val m = find(id)
        if (parseSpec(m.specJson).tcp == null) throw BadRequestException("TCP Mock이 아닙니다.")
        if (extendMs !in 1_000..3_600_000) throw BadRequestException("연장 시간은 1초~1시간이어야 합니다.")
        return tcpRegistry.extendSession(id, sessionId, extendMs)
    }

    /**
     * 보내보기 — 프로토콜로 요청 전문을 조립해 **실제 리스너 포트**로 1회 왕복하고 응답을 해석해 돌려준다.
     * (규칙 매칭·장애 주입·프록시까지 그대로 타므로 편집기에서 "진짜 되는지"를 확인할 수 있다.)
     */
    // @Transactional 없음 — 소켓 왕복(최대 timeoutMs) 동안 DB 커넥션을 붙잡지 않는다(조회는 리포지토리 자체 트랜잭션).
    fun tcpSend(id: UUID, req: MockDtos.TcpSendRequest): MockDtos.TcpSendResult {
        val m = findReadable(id)
        val mockSpec = parseSpec(m.specJson)
        val tcp = mockSpec.tcp ?: throw BadRequestException("TCP Mock 이 아닙니다.")
        val scope = secretProvider.scope(m.tenantId, mockSpec.environment, cached = false, workspaceId = m.workspaceId, spec = mockSpec)
        val resolve = scope.resolver()
        val port = tcpRegistry.listeningPort(id) ?: throw BadRequestException("리스너가 열려 있지 않습니다(Mock 켜짐·프로토콜 선택 확인).")
        val pid = tcp.protocolId?.trim()?.takeIf { it.isNotEmpty() } ?: throw BadRequestException("프로토콜을 먼저 고르세요.")
        val captured = if (scope.protocol == null) protocolService.snapshot(pid, resourceScope(mockSpec, m.workspaceId), resourceIdentity(mockSpec)) else null
        val spec = scope.protocol ?: captured!!.spec
        val plugins = scope.codecLookup ?: captured!!.plugins
        var secretUsed = SecretMasker.usesSecrets(scope.secrets.values, spec, mockSpec, req.values)
        val hideCodecErrors = secretUsed || (scope.secrets.isNotEmpty() && ProtocolCompiler.pluginRefs(spec).isNotEmpty())
        val enc = try {
            ProtocolCompiler.assemble(spec, req.key, req.values.orEmpty(), req.transactionKey, plugins = plugins, resolve = resolve)
        } catch (e: Exception) {
            if (hideCodecErrors) throw BadRequestException(SecretMasker.DERIVED_ERROR)
            if (e is ProtocolCodec.ProtocolException) throw BadRequestException(scope.mask(e.message ?: "조립 실패"))
            throw e
        }
        val executionId = if (spec.schemaVersion == 2) req.executionId ?: UUID.randomUUID() else null
        if (executionId != null) trials?.start(executionId, m.workspaceId, m.id, m.currentVersionOrZero(),
            scope.protocolFingerprint ?: captured?.fingerprint)
        val started = System.nanoTime()
        var failure: TcpClient.ExchangeException? = null
        val x = try {
            TcpClient.exchange("127.0.0.1", port, tcp.timeoutMs?.takeIf { it > 0 } ?: 5000, enc.bytes, spec, plugins = plugins, resolve = resolve)
        } catch (e: TcpClient.ExchangeException) {
            failure = e
            TcpClient.Exchange(e.response ?: com.flowlink.protocol.Framer.Frame(ByteArray(0), emptyList(), false), (System.nanoTime() - started) / 1_000_000,
                transactionKey = enc.transactionKey, steps = e.steps)
        } catch (e: Exception) {
            if (executionId == null) throw BadRequestException(if (hideCodecErrors) SecretMasker.DERIVED_ERROR else "전송 실패: ${scope.mask(e.message.orEmpty())}")
            val error = TcpClient.ExchangeException("TRANSPORT_FAILED", "REQUEST", enc.bytes.size, 0, emptyList(), null, e)
            failure = error
            TcpClient.Exchange(com.flowlink.protocol.Framer.Frame(ByteArray(0), emptyList(), false), (System.nanoTime() - started) / 1_000_000,
                transactionKey = enc.transactionKey, steps = error.steps)
        }
        val d = if (x.response.bytes.isEmpty()) null else try {
            ProtocolCompiler.parse(spec, x.response.bytes, transactionKey = x.transactionKey, phase = "response", requestFields = enc.values, plugins = plugins, resolve = resolve)
        } catch (e: Exception) {
            if (executionId == null) throw BadRequestException(if (hideCodecErrors) SecretMasker.DERIVED_ERROR else scope.mask(e.message ?: "응답 해석 실패"))
            failure = TcpClient.ExchangeException("RESPONSE_INVALID", "RESPONSE", null, x.response.bytes.size, x.steps, x.response, e)
            null
        }
        val cs = spec.charset()
        secretUsed = secretUsed || SecretMasker.usesSecrets(scope.secrets.values, d?.values)
        val requestBytes = if (secretUsed) ByteArray(enc.bytes.size) { '*'.code.toByte() } else scope.maskBytes(enc.bytes)
        val responseBytes = if (secretUsed) ByteArray(x.response.bytes.size) { '*'.code.toByte() } else scope.maskBytes(x.response.bytes)
        fun safe(value: String) = if (secretUsed) "***" else scope.mask(value)
        val headerNames = spec.headerOrEmpty().map { it.nameOrEmpty() }.toSet()
        val result = MockDtos.TcpSendResult(
            ProtocolDtos.PreviewResult(enc.bytes.size, TcpBytes.hexDump(requestBytes), TcpBytes.printable(requestBytes, cs), enc.fields.map { it.copy(value = safe(it.value), warn = it.warn?.let { safe(it) }) }, emptyList(), if (secretUsed) emptyList() else enc.warnings.map(scope::mask)),
            MockDtos.DecodedView(
                d?.transactionKey?.let { ProtocolCompiler.compile(spec).transaction(it).responseMessage } ?: spec.lookup(d?.values?.get(spec.discriminator), Direction.RECV)?.key, d?.values?.get(spec.discriminator),
                d?.values.orEmpty().filterKeys { it in headerNames }.mapValues { safe(it.value) }, d?.values?.filterKeys { it !in headerNames }?.mapValues { safe(it.value) }, TcpBytes.decodeEscaped(responseBytes, cs),
                TcpBytes.hexDump(responseBytes), x.response.bytes.size, x.response.chunks, x.response.partial, if (secretUsed) emptyList() else d?.warnings.orEmpty().map(scope::mask),
            ),
            x.elapsedMs, x.transactionKey, x.steps, executionId, if (failure == null) "SUCCEEDED" else "FAILED",
            failure?.let { mapOf("code" to it.code, "phase" to it.phase, "expectedBytes" to it.expectedBytes, "actualBytes" to it.actualBytes,
                "repairHint" to "execution_get으로 이미 전송된 단계부터 확인하세요. 자동 재전송하지 않습니다.") },
            if (executionId == null) emptyList() else listOf("시험 이력은 재시작 전 최근 1000건·JSON 합계 32MB만 보존합니다. DB 워크플로 이력과 별도이며 UNKNOWN은 조회로 확인하세요."),
        )
        if (executionId != null) trials?.complete(executionId, result)
        return result
    }

    /**
     * 저장 전 TCP 규칙 검증 — 리스너가 열린 뒤에야 드러나는 실패(응답 전문 없음/필드 오타/upstream 누락)를 400 으로 앞당긴다.
     * 프로토콜을 아직 안 고른 spec 은 규칙 검사를 건너뛴다(편집 중 저장 허용 — 리스너도 안 열린다).
     */
    private fun validateTcp(spec: MockSpec, workspaceId: UUID?) {
        if (spec.resourceWorkspaceId != null && spec.resourceWorkspaceId != "public") throw BadRequestException("공통 자원 공간은 public만 선택할 수 있습니다.")
        if (spec.envSource != null && spec.envSource !in setOf("local", "server")) throw BadRequestException("알 수 없는 환경 출처입니다.")
        if (spec.resourceWorkspaceId == "public" && !workspace.localRuntime && spec.envSource == "local") throw BadRequestException("서버 Mock에서는 내 PC 환경을 사용할 수 없습니다.")
        if (workspace.localRuntime && spec.resourceWorkspaceId != "public" && (listOf(spec.codec) + spec.routesOrEmpty().map { it.codec }).any { !it?.request.isNullOrEmpty() || !it?.response.isNullOrEmpty() })
            throw BadRequestException("개인 Mock에서는 플러그인 코덱을 사용할 수 없습니다. 기존 코덱을 제거하세요.")
        spec.tcp?.port?.let { tcpRegistry.validatePort(it) }
        val tcp = spec.tcp ?: return
        val pid = tcp.protocolId?.trim()
        val proto = if (pid.isNullOrEmpty()) null else try {
            if (spec.resourceWorkspaceId == "public") protocolService.spec(pid, null, resourceIdentity(spec)) else protocolService.specOf(UUID.fromString(pid), workspaceId = workspaceId)
        } catch (e: Exception) { throw BadRequestException("TCP Mock 의 프로토콜을 찾을 수 없습니다: $pid") }
        for ((i, r) in tcp.rulesOrEmpty().withIndex()) {
            if (proto?.schemaVersion == 2) {
                ProtocolCompiler.compile(proto)
                val responseMode = r.then?.mode
                if (responseMode != null && responseMode !in setOf("mock", "proxy")) throw ProtocolCompiler.CompileException(listOf(ProtocolCompiler.ValidationError("INVALID_SCHEMA", "tcp.rules[$i].then.mode", "mock 또는 proxy를 사용하세요.")))
                val requestNames = (proto.headerOrEmpty() + proto.transactions.orEmpty().flatMap { proto.message(it.requestMessage.orEmpty())?.fieldsOrEmpty().orEmpty() }).map { it.nameOrEmpty() }.toSet()
                r.whenOrEmpty().forEachIndexed { ci, condition ->
                    if (condition.op != null && condition.op !in setOf("eq", "ne", "contains", "startswith", "endswith", "regex", "exists")) throw ProtocolCompiler.CompileException(listOf(ProtocolCompiler.ValidationError("INVALID_SCHEMA", "tcp.rules[$i].when[$ci].op", "지원하지 않는 조건 연산자입니다.")))
                    if (condition.field !in requestNames) throw ProtocolCompiler.CompileException(listOf(ProtocolCompiler.ValidationError("INVALID_SCHEMA", "tcp.rules[$i].when[$ci].field", "요청 전문에 없는 필드입니다.")))
                    if (condition.op != "exists" && condition.value == null) throw ProtocolCompiler.CompileException(listOf(ProtocolCompiler.ValidationError("INVALID_SCHEMA", "tcp.rules[$i].when[$ci].value", "조건 비교값이 필요합니다.")))
                }
            }
            if (r.isProxy()) {
                if (tcp.upstream.isNullOrBlank()) throw BadRequestException("규칙 ${i + 1}: proxy 인데 upstream(실서버 host:port)이 없습니다.")
                continue
            }
            if (proto == null) continue
            val f = r.thenFields()
            if (proto.schemaVersion == 2) {
                val candidates = proto.transactions.orEmpty().filter { tx -> tx.`when`.orEmpty().all { selection ->
                    r.whenOrEmpty().none { it.field == selection.field && (it.op == null || it.op == "eq") && it.value != selection.value }
                } }
                for (transaction in candidates) {
                    val allowed = (proto.headerOrEmpty() + proto.message(transaction.responseMessage.orEmpty())?.fieldsOrEmpty().orEmpty()).map { it.nameOrEmpty() }.toSet()
                    val required = proto.message(transaction.responseMessage.orEmpty())?.fieldsOrEmpty().orEmpty().map { it.nameOrEmpty() }.toSet()
                    val reqFields = (proto.headerOrEmpty() + proto.message(transaction.requestMessage.orEmpty())?.fieldsOrEmpty().orEmpty()).map { it.nameOrEmpty() }.toSet()
                    f.keys.firstOrNull { it !in allowed }?.let { throw ProtocolCompiler.CompileException(listOf(ProtocolCompiler.ValidationError("INVALID_SCHEMA", "tcp.rules[$i].then.fields.$it", "선택 거래 응답에 없는 필드입니다."))) }
                    required.firstOrNull { it !in f }?.let { throw ProtocolCompiler.CompileException(listOf(ProtocolCompiler.ValidationError("MISSING_CONTEXT_FIELD", "tcp.rules[$i].then.fields.$it", "v2 응답 업무 필드를 명시하세요."))) }
                    f.forEach { (name, template) -> Regex("\\{\\{\\s*req\\.([^{}\\s]+)\\s*}}").findAll(template).forEach { token ->
                        if (token.groupValues[1] !in reqFields) throw ProtocolCompiler.CompileException(listOf(ProtocolCompiler.ValidationError("MISSING_CONTEXT_FIELD", "tcp.rules[$i].then.fields.$name", "선택 거래 요청에 없는 필드 참조입니다.")))
                    } }
                }
                continue
            }
            val disc = if (proto.hasDiscriminator()) f[proto.discriminator!!.trim()]?.trim()?.takeIf { it.isNotEmpty() } else null
            if (proto.hasDiscriminator() && disc == null) {
                // 응답 표는 요청 헤더 에코가 고른다(런타임) — 여기선 어느 전문에도 없는 필드명(오타)만 잡는다
                val known = (proto.headerOrEmpty() + proto.messagesOrEmpty().flatMap { it.fieldsOrEmpty() }).map { it.nameOrEmpty() }.toSet()
                f.keys.firstOrNull { it !in known }?.let {
                    throw BadRequestException("규칙 ${i + 1}: '$it' 는 프로토콜의 어떤 전문에도 없는 필드입니다.")
                }
                continue
            }
            val msg = proto.lookup(disc, Direction.RECV)
                ?: throw BadRequestException("규칙 ${i + 1}: 응답 전문 '${disc ?: "response"}' 정의가 프로토콜에 없습니다.")
            val allowed = (proto.headerOrEmpty() + msg.fieldsOrEmpty()).map { it.nameOrEmpty() }.toSet()
            f.keys.firstOrNull { it !in allowed }?.let {
                throw BadRequestException("규칙 ${i + 1}: '$it' 는 응답 전문 ${msg.keyOrEmpty()} 에 없는 필드입니다.")
            }
        }
    }

    companion object {
        private val SLUG: Pattern = Pattern.compile("[a-z0-9-]{3,40}")
        /** mock 당 유지할 정의 스냅샷 수(📌 보존 제외). */
        const val VERSIONS_KEEP = 50
        const val USAGE_TTL_MS = 30_000L
    }

    private fun tenant(): String = TenantContext.getTenantId()
}

class MockActivationException(val code: String, val previous: Map<String, Any?>) : RuntimeException("Mock 활성화에 실패했습니다. 기존 정의와 실제 리스너 상태를 확인하세요.")
