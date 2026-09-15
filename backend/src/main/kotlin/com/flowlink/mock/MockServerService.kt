package com.flowlink.mock

import com.fasterxml.jackson.databind.JsonNode
import com.flowlink.common.error.BadRequestException
import com.flowlink.common.error.NotFoundException
import com.flowlink.common.json.JsonService
import com.flowlink.common.tcp.TcpBytes
import com.flowlink.common.tenant.TenantContext
import com.flowlink.core.domain.MockServer
import com.flowlink.core.repository.MockServerRepository
import com.flowlink.mock.MockDtos.CreateMockServerRequest
import com.flowlink.mock.MockDtos.MockServerDetail
import com.flowlink.mock.MockDtos.MockServerSummary
import com.flowlink.mock.MockDtos.UpdateMockServerRequest
import com.flowlink.protocol.Direction
import com.flowlink.protocol.ProtocolCodec
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
) {

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
        wsViews.add(MockDtos.FleetWorkspace(com.flowlink.workspace.WorkspaceService.PUBLIC_ID, "공용", "PUBLIC", role(null), mine = true))
        for (ws in workspace.listAll()) {
            val mine = if (ws.kind == com.flowlink.core.domain.Workspace.KIND_PERSONAL) ws.ownerUsername == me else workspace.isMember(me, ws.id)
            wsViews.add(MockDtos.FleetWorkspace(ws.id.toString(), ws.name, ws.kind, role(ws.id), mine, ws.ownerUsername))
        }
        val index = usageIndex()
        val names = protocolNames()
        val canRead: (UUID?) -> Boolean = { ws -> role(ws) != null }
        val servers = repository.findByTenantIdOrderByUpdatedAtDesc(tenant()).map { m ->
            val r = role(m.workspaceId)
            val readable = r != null
            val s = toSummary(m, names)
            val listeningPort = tcpRegistry.listeningPort(m.id)
            val shouldListen = m.isEnabled && s.tcpPort != null && s.tcpEnabled != false
            MockDtos.FleetServer(
                m.id, m.name, m.slug, m.kind.name, m.isEnabled, m.workspaceId?.toString() ?: com.flowlink.workspace.WorkspaceService.PUBLIC_ID, readable, r,
                s.tcpPort, s.tcpEnabled, listeningPort != null,
                if (shouldListen && listeningPort == null) (tcpRegistry.bindFailure(m.id) ?: "리스너가 열려 있지 않습니다") else null,
                s.routeCount, if (readable) s.routeLabels else emptyList(), s.tcpRuleCount,
                if (readable) s.protocolName else null, if (readable) s.upstream else null, s.hasCodec, if (readable) s.environment else null,
                s.lastRequestAt, s.recentRequests, s.requestCount, s.unmatchedRequests, s.currentVersion, m.updatedAt,
                if (readable) usedBy(m.slug, index, canRead) else emptyList(),
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
            val refs = usedBy(m.slug, index, ::canRead)
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
    private fun usedBy(slug: String, index: List<Pair<com.flowlink.core.domain.Flow, String>>, canRead: (UUID?) -> Boolean): List<MockDtos.FlowRef> {
        val re = Regex("/mock/(?:[^/\"\\s]+/)?" + Regex.escape(slug) + "(?=[/\"?\\s]|$)")
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
        if (repository.existsByTenantIdAndSlug(tenant(), slug)) {
            // 서빙 주소(/mock/{slug})가 워크스페이스와 무관한 전역 경로라 slug 는 전체에서 유일해야 한다
            throw BadRequestException("이미 사용 중인 slug 입니다: $slug — 서빙 주소가 전역이라 다른 워크스페이스의 slug 와도 겹칠 수 없습니다. 다른 이름을 쓰세요(예: $slug-2).")
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
        if (req.name != null && req.name.isNotBlank()) {
            m.name = req.name
        }
        if (req.enabled != null) {
            m.isEnabled = req.enabled
        }
        if (req.workspaceId != null) {
            // 워크스페이스 이동 — 대상에도 쓰기 권한. slug 는 테넌트 전역 유니크라 충돌 없음.
            val target = workspace.resolveId(req.workspaceId)
            if (target != m.workspaceId) {
                workspace.requireWrite(workspace.currentUsername(), target)
                m.workspaceId = target
                usageCache.clear()
            }
        }
        val saved = repository.save(m)
        tcpRegistry.sync(saved) // enabled 토글에 맞춰 TCP 리스너 열기/닫기
        return toDetail(saved)
    }

    @Transactional
    fun updateSpec(id: UUID, spec: JsonNode?, note: String? = null, pinned: Boolean = false): MockServerDetail {
        val m = find(id)
        if (spec == null || spec.isNull) {
            throw BadRequestException("spec 이 없습니다.")
        }
        val raw = spec.toString()
        // 저장 전 파싱 + TCP 규칙 검증 — 깨진 spec 이 게이트웨이에서 500 을 만들거나, 절대 응답 못 하는 규칙이 저장되지 않게 한다
        validateTcp(parseSpec(raw))
        // 구조 비교 — 저장된 spec 이 pretty-print(생성 기본값/복원)라도 내용이 같으면 스냅샷을 만들지 않는다
        val changed = try { json.readTree(raw) != json.readTree(m.specJson ?: "{}") } catch (e: Exception) { true }
        m.specJson = raw
        val saved = repository.save(m)
        // 내용이 바뀌었거나 📌 보존 요청이면 스냅샷(같은 내용 재저장은 버전 낭비 방지)
        if (changed || pinned || !note.isNullOrBlank()) snapshot(saved, note?.trim()?.takeIf { it.isNotEmpty() }, pinned)
        tcpRegistry.sync(saved) // 포트 바인딩 실패/충돌은 BadRequest → 저장 롤백
        digestCache.remove(m.id)
        return toDetail(saved)
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
        parseSpec(src.specJson)
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
        findReadable(id)
        if (!workspace.isApproved(workspace.currentUsername())) throw com.flowlink.common.error.ForbiddenException("코덱 시험은 가입 승인 후 가능합니다(시크릿 값 사용).")
        val codec = req.codec ?: throw BadRequestException("codec 이 없습니다.")
        val side = (req.side ?: "request").lowercase(Locale.ROOT)
        val secrets = secretProvider.secrets(tenant(), req.environment)
        val mapper = json.mapper()
        val lookup: (String) -> com.flowlink.transform.FlowTransform? = { transforms.get(it).orElse(null) }
        val traces = ArrayList<MockCodec.StepTrace>()
        val headersIn = LinkedHashMap<String, String>()
        for ((k, v) in req.headers ?: emptyMap()) headersIn[k.lowercase(Locale.ROOT)] = v
        val ct = req.contentType?.takeIf { it.isNotBlank() } ?: headersIn["content-type"] ?: "application/json"
        val message = req.message ?: ""
        val masks = com.flowlink.execution.engine.SecretMasker.variants(secrets.values)
        fun m(s: String) = com.flowlink.execution.engine.SecretMasker.mask(s, masks) ?: s
        try {
            if (side == "response") {
                val ctx = MockContext(req = MockHttp.MockRequest("POST", "/", emptyMap(), headersIn, "", emptyMap()), seq = 1001L, secrets = secrets, json = mapper)
                val headers = LinkedHashMap<String, String>()
                val out = MockCodec.applyResponse(codec.response, message, headers, ct, ctx, lookup, mapper, traces)
                return MockDtos.CodecTryResult(m(out), headers.mapValues { m(it.value) }, emptyMap(), traces.map { it.copy(input = m(it.input), output = m(it.output)) })
            }
            val cs = MockHttp.charsetFromContentType(ct)
            if (!headersIn.containsKey("content-type")) headersIn["content-type"] = ct
            val request = MockHttp.MockRequest("POST", "/", emptyMap(), headersIn, message, MockHttp.parseBodyFields(message, ct, cs, mapper))
            val ctx = MockContext(seq = 1001L, secrets = secrets, json = mapper)
            val out = MockCodec.applyRequest(codec.request, request, ctx, lookup, mapper, traces)
            return MockDtos.CodecTryResult(m(out.bodyText), out.headers.mapValues { m(it.value) }, out.bodyFields.mapValues { m(it.value) }, traces.map { it.copy(input = m(it.input), output = m(it.output)) })
        } catch (e: MockCodec.CodecException) {
            throw BadRequestException(e.message ?: "코덱 실패")
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
    fun slugAvailable(slugRaw: String): Boolean {
        val slug = slugRaw.lowercase(Locale.ROOT)
        if (!SLUG.matcher(slug).matches()) return false
        return !repository.existsByTenantIdAndSlug(tenant(), slug)
    }

    /** 게이트웨이 서빙용 — 무인증. tenant 는 경로 세그먼트에서 온다(레거시 경로는 default 테넌트). */
    @Transactional(readOnly = true)
    fun findForServing(tenantId: String, slug: String): Optional<MockServer> =
        repository.findByTenantIdAndSlug(tenantId, slug).filter { it.isEnabled }

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

    private fun toSummary(m: MockServer, protocolNames: Map<String, String> = emptyMap()): MockServerSummary {
        val hit = digestCache[m.id]
        val d = if (hit != null && hit.first == m.updatedAt) hit.second else digestOf(m.specJson).also { digestCache[m.id] = m.updatedAt to it }
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
            last, recent, count, unmatched, m.currentVersionOrZero(),
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
            m.isEnabled, spec, m.createdAt, m.updatedAt, m.workspaceId, m.currentVersionOrZero()
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

    /**
     * 보내보기 — 프로토콜로 요청 전문을 조립해 **실제 리스너 포트**로 1회 왕복하고 응답을 해석해 돌려준다.
     * (규칙 매칭·장애 주입·프록시까지 그대로 타므로 편집기에서 "진짜 되는지"를 확인할 수 있다.)
     */
    // @Transactional 없음 — 소켓 왕복(최대 timeoutMs) 동안 DB 커넥션을 붙잡지 않는다(조회는 리포지토리 자체 트랜잭션).
    fun tcpSend(id: UUID, req: MockDtos.TcpSendRequest): MockDtos.TcpSendResult {
        val m = findReadable(id)
        val tcp = parseSpec(m.specJson).tcp ?: throw BadRequestException("TCP Mock 이 아닙니다.")
        val port = tcpRegistry.listeningPort(id) ?: throw BadRequestException("리스너가 열려 있지 않습니다(Mock 켜짐·프로토콜 선택 확인).")
        val spec = protocolService.specOf(UUID.fromString(tcp.protocolId!!.trim()), m.tenantId)
        val key = req.key?.trim()?.takeIf { it.isNotEmpty() } ?: throw BadRequestException("전문(key)을 고르세요.")
        val enc = try {
            ProtocolCodec.encode(spec, key, req.values ?: emptyMap(), Direction.SEND, protocolService.plugins())
        } catch (e: ProtocolCodec.ProtocolException) { throw BadRequestException(e.message ?: "조립 실패") }
        val x = try {
            TcpClient.exchange("127.0.0.1", port, tcp.timeoutMs?.takeIf { it > 0 } ?: 5000, enc.bytes, spec)
        } catch (e: Exception) { throw BadRequestException("전송 실패: ${e.message}") }
        val d = ProtocolCodec.decode(spec, x.response.bytes, Direction.RECV, protocolService.plugins())
        val cs = spec.charset()
        return MockDtos.TcpSendResult(
            ProtocolDtos.PreviewResult(enc.bytes.size, TcpBytes.hexDump(enc.bytes), TcpBytes.printable(enc.bytes, cs), enc.fields, emptyList(), enc.warnings),
            MockDtos.DecodedView(
                d.messageKey, d.disc, d.header, d.body, TcpBytes.decodeEscaped(x.response.bytes, cs),
                TcpBytes.hexDump(x.response.bytes), x.response.bytes.size, x.response.chunks, d.warnings,
            ),
            x.elapsedMs,
        )
    }

    /**
     * 저장 전 TCP 규칙 검증 — 리스너가 열린 뒤에야 드러나는 실패(응답 전문 없음/필드 오타/upstream 누락)를 400 으로 앞당긴다.
     * 프로토콜을 아직 안 고른 spec 은 규칙 검사를 건너뛴다(편집 중 저장 허용 — 리스너도 안 열린다).
     */
    private fun validateTcp(spec: MockSpec) {
        val tcp = spec.tcp ?: return
        val pid = tcp.protocolId?.trim()
        val proto = if (pid.isNullOrEmpty()) null else try {
            protocolService.specOf(UUID.fromString(pid))
        } catch (e: Exception) { throw BadRequestException("TCP Mock 의 프로토콜을 찾을 수 없습니다: $pid") }
        for ((i, r) in tcp.rulesOrEmpty().withIndex()) {
            if (r.isProxy()) {
                if (tcp.upstream.isNullOrBlank()) throw BadRequestException("규칙 ${i + 1}: proxy 인데 upstream(실서버 host:port)이 없습니다.")
                continue
            }
            if (proto == null) continue
            val f = r.thenFields()
            val disc = if (proto.hasDiscriminator()) f[proto.discriminator!!.trim()] else null
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
