package com.flowlink.mock

import com.fasterxml.jackson.databind.JsonNode
import com.flowlink.common.error.BadRequestException
import com.flowlink.common.error.NotFoundException
import com.flowlink.common.json.JsonService
import com.flowlink.common.tenant.TenantContext
import com.flowlink.core.domain.MockServer
import com.flowlink.core.repository.MockServerRepository
import com.flowlink.mock.MockDtos.CreateMockServerRequest
import com.flowlink.mock.MockDtos.MockServerDetail
import com.flowlink.mock.MockDtos.MockServerSummary
import com.flowlink.mock.MockDtos.UpdateMockServerRequest
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
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
) {

    @Transactional(readOnly = true)
    fun list(workspaceIdRaw: String? = null): List<MockServerSummary> {
        val wsId = workspace.resolveId(workspaceIdRaw)
        workspace.requireRead(workspace.currentUsername(), wsId)
        return repository.findByTenantIdOrderByUpdatedAtDesc(tenant())
            .filter { it.workspaceId == wsId }
            .map { toSummary(it) }
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
        tcpRegistry.sync(saved) // TCP 면 pickFreePort 로 고른 빈 포트에 바인딩(충돌 없음)
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
        val saved = repository.save(m)
        tcpRegistry.sync(saved) // enabled 토글에 맞춰 TCP 리스너 열기/닫기
        return toDetail(saved)
    }

    @Transactional
    fun updateSpec(id: UUID, spec: JsonNode?): MockServerDetail {
        val m = find(id)
        if (spec == null || spec.isNull) {
            throw BadRequestException("spec 이 없습니다.")
        }
        val raw = spec.toString()
        // 저장 전 파싱 검증 — 깨진 spec 이 게이트웨이에서 500 을 만들지 않게 한다
        parseSpec(raw)
        m.specJson = raw
        val saved = repository.save(m)
        tcpRegistry.sync(saved) // 포트 바인딩 실패/충돌은 BadRequest → 저장 롤백
        return toDetail(saved)
    }

    @Transactional
    fun delete(id: UUID) {
        val m = find(id)
        repository.delete(m)
        tcpRegistry.stop(m.id)
        store.forget(m.id)
    }

    /** 요청 기록(journal, 최신순) — 테넌트 소유 확인 후. */
    @Transactional(readOnly = true)
    /** TCP 전문 미리보기(저장·소켓 없음) — 코덱/시크릿 환경까지 실제 리스너와 같은 경로. 잘못된 길이·코덱 실패는 400. */
    fun previewTcp(req: MockDtos.TcpPreviewRequest): TcpMockEngine.Preview {
        val tcp = req.tcp ?: throw BadRequestException("tcp 섹션이 없습니다.")
        val secrets = if (req.codec == null) emptyMap() else secretProvider.secrets(tenant(), req.environment)
        return try {
            TcpMockEngine.preview(tcp, req.sample ?: "", codec = req.codec, secrets = secrets, lookup = { transforms.get(it).orElse(null) })
        } catch (e: IllegalArgumentException) {
            throw BadRequestException(e.message ?: "TCP 미리보기 실패")
        } catch (e: MockCodec.CodecException) {
            throw BadRequestException(e.message ?: "코덱 실패")
        }
    }

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

    private fun toSummary(m: MockServer): MockServerSummary =
        MockServerSummary(m.id, m.name, m.slug, m.kind.name, m.isEnabled, m.updatedAt, m.workspaceId)

    private fun toDetail(m: MockServer): MockServerDetail {
        val specJson = m.specJson
        val spec: JsonNode = if (specJson == null || specJson.isBlank()) {
            json.mapper().createObjectNode()
        } else {
            json.readTree(specJson)
        }
        return MockServerDetail(
            m.id, m.name, m.slug, m.kind.name,
            m.isEnabled, spec, m.createdAt, m.updatedAt, m.workspaceId
        )
    }

    /** 새 HTTP 서버의 시작 예시 — 편집기에서 바로 고쳐 쓰는 안내 겸용. */
    private fun defaultCustomSpec(): String = """
        {"routes":[{"id":"r1","method":"GET","path":"/hello","rules":[
          {"id":"u1","status":200,"contentType":"json",
           "body":"{\"message\":\"안녕하세요 {{query.name}}\",\"seq\":\"{{seq}}\"}"}
        ]}]}""".trimIndent()

    /**
     * 새 TCP 서버의 시작 예시 — 빈 포트에 4자리 길이 프리픽스 EUC-KR 전문.
     * 요청 레이아웃(전문코드4·계좌10)과 필드 모드 응답(코드4·계좌 에코10·잔액12 좌측0·고객명10) — 텍스트 대신 필드로 시작하게.
     */
    private fun defaultTcpSpec(port: Int): String = """
        {"tcp":{"enabled":true,"port":$port,"charset":"EUC-KR","prefixLength":4,"prefixIncludesSelf":false,
          "requestFields":[{"id":"q1","name":"전문코드","length":4},{"id":"q2","name":"계좌번호","length":10}],
          "rules":[{"id":"t1","contains":"","when":[],"response":"",
            "responseFields":[
              {"id":"f1","name":"응답코드","length":4,"value":"0000"},
              {"id":"f2","name":"계좌번호","length":10,"value":"{{req.계좌번호}}"},
              {"id":"f3","name":"잔액","length":12,"value":"1500000","pad":"left","padChar":"0"},
              {"id":"f4","name":"고객명","length":10,"value":"홍길동"}]}]}}""".trimIndent()

    companion object {
        private val SLUG: Pattern = Pattern.compile("[a-z0-9-]{3,40}")
    }

    private fun tenant(): String = TenantContext.getTenantId()
}
