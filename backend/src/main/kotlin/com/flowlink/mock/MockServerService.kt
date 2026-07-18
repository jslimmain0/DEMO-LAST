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

/** Mock 서버 관리(테넌트 스코프 CRUD) + 서빙 조회(무인증, slug 팀 스코프 유니크). */
@Service
class MockServerService(
    private val repository: MockServerRepository,
    private val json: JsonService,
    private val tcpRegistry: TcpMockRegistry,
    private val store: MockRuntimeStore
) {

    @Transactional(readOnly = true)
    fun list(): List<MockServerSummary> =
        repository.findByTenantIdOrderByUpdatedAtDesc(tenant())
            .map { toSummary(it) }

    @Transactional
    fun create(req: CreateMockServerRequest): MockServerDetail {
        val slug = req.slug.lowercase(Locale.ROOT)
        if (!SLUG.matcher(slug).matches()) {
            throw BadRequestException("slug 는 소문자·숫자·하이픈 3~40자여야 합니다: $slug")
        }
        if (repository.existsByTenantIdAndSlug(tenant(), slug)) {
            throw BadRequestException("이미 사용 중인 slug 입니다: $slug")
        }
        // 유형 선택 — TCP 면 tcp 섹션만, 그 외(기본)는 HTTP 라우트만. CUSTOM(둘 다)은 레거시 데이터 전용.
        val kind = if (req.type?.uppercase(Locale.ROOT) == "TCP") MockServer.Kind.TCP else MockServer.Kind.HTTP
        val spec = if (kind == MockServer.Kind.TCP) defaultTcpSpec(tcpRegistry.pickFreePort()) else defaultCustomSpec()
        // saveAndFlush: 신규 엔티티라 @CreationTimestamp lateinit createdAt/updatedAt 가 flush 후 채워진다
        // (toDetail 이 이를 읽으므로 flush 전 접근하면 UninitializedPropertyAccessException). FlowService.createInternal 과 동일.
        val saved = repository.saveAndFlush(
            MockServer.create(tenant(), req.name, slug, kind, spec)
        )
        tcpRegistry.sync(saved) // TCP 면 pickFreePort 로 고른 빈 포트에 바인딩(충돌 없음)
        return toDetail(saved)
    }

    @Transactional(readOnly = true)
    fun get(id: UUID): MockServerDetail = toDetail(find(id))

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
    fun requests(id: UUID): List<MockDtos.MockRequestLog> {
        find(id)
        return store.journal(id).map {
            MockDtos.MockRequestLog(it.at, it.method, it.path, it.query, it.headers, it.bodyText, it.matchedRuleId, it.status, it.delayMs, it.callbackFired)
        }
    }

    @Transactional(readOnly = true)
    fun clearRequests(id: UUID) { find(id); store.clearJournal(id) }

    /** 런타임 상태 초기화(state·seq·hits·journal) — 재시작 없이 깨끗한 상태로. */
    @Transactional(readOnly = true)
    fun reset(id: UUID) { find(id); store.reset(id) }

    /** 현재 런타임 상태 스냅샷(state·seq·hits·요청수). */
    @Transactional(readOnly = true)
    fun runtimeState(id: UUID): MockDtos.MockStateView {
        find(id)
        val s = store.snapshot(id)
        return MockDtos.MockStateView(s.state, s.seq, s.hits, s.requestCount)
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

    private fun find(id: UUID): MockServer =
        repository.findByIdAndTenantId(id, tenant())
            .orElseThrow { NotFoundException("Mock 서버가 없습니다: $id") }

    private fun toSummary(m: MockServer): MockServerSummary =
        MockServerSummary(m.id, m.name, m.slug, m.kind.name, m.isEnabled, m.updatedAt)

    private fun toDetail(m: MockServer): MockServerDetail {
        val specJson = m.specJson
        val spec: JsonNode = if (specJson == null || specJson.isBlank()) {
            json.mapper().createObjectNode()
        } else {
            json.readTree(specJson)
        }
        return MockServerDetail(
            m.id, m.name, m.slug, m.kind.name,
            m.isEnabled, spec, m.createdAt, m.updatedAt
        )
    }

    /** 새 HTTP 서버의 시작 예시 — 편집기에서 바로 고쳐 쓰는 안내 겸용. */
    private fun defaultCustomSpec(): String = """
        {"routes":[{"id":"r1","method":"GET","path":"/hello","rules":[
          {"id":"u1","status":200,"contentType":"json",
           "body":"{\"message\":\"안녕하세요 {{query.name}}\",\"seq\":\"{{seq}}\"}"}
        ]}]}""".trimIndent()

    /** 새 TCP 서버의 시작 예시 — 빈 포트에 4자리 길이 프리픽스 EUC-KR 전문. 앞 4바이트가 응답코드가 되게 에코. */
    private fun defaultTcpSpec(port: Int): String = """
        {"tcp":{"enabled":true,"port":$port,"charset":"EUC-KR","prefixLength":4,"prefixIncludesSelf":false,
          "rules":[{"id":"t1","contains":"","response":"0000{{req:4:20}}"}]}}""".trimIndent()

    companion object {
        private val SLUG: Pattern = Pattern.compile("[a-z0-9-]{3,40}")
    }

    private fun tenant(): String = TenantContext.getTenantId()
}
