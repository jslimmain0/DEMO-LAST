package com.flowlink.assistant

import com.fasterxml.jackson.databind.JsonNode
import com.flowlink.common.error.NotFoundException
import com.flowlink.common.json.JsonService
import com.flowlink.common.tenant.TenantContext
import com.flowlink.core.domain.AssistantSession
import com.flowlink.core.repository.AssistantSessionRepository
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.util.UUID

/**
 * AI 어시스턴트 대화 세션 저장소 — 사용자별(tenant + username) 목록/이어하기.
 * 프론트가 각 대화 뒤 upsert 로 자동 저장하고, 목록에서 골라 이어서 대화한다.
 */
@Service
class AssistantSessionService(
    private val repo: AssistantSessionRepository,
    private val json: JsonService,
) {
    private val mapper = json.mapper()

    @Transactional(readOnly = true)
    fun list(): List<SessionSummary> =
        repo.findByTenantIdAndUsernameOrderByUpdatedAtDesc(tenant(), user())
            .map { SessionSummary(it.id, it.title, it.updatedAt, countTurns(it.messages)) }

    @Transactional(readOnly = true)
    fun get(id: UUID): SessionDetail = detail(load(id))

    @Transactional
    fun create(req: SaveSessionRequest): SessionDetail {
        val msgs = req.messages ?: mapper.createArrayNode()
        val title = resolveTitle(req.title, msgs)
        val s = AssistantSession.create(tenant(), user(), title, mapper.writeValueAsString(msgs))
        // saveAndFlush: @CreationTimestamp/@UpdateTimestamp(lateinit)가 flush 시점에 채워지므로 detail() 읽기 전에 강제 flush.
        return detail(repo.saveAndFlush(s))
    }

    @Transactional
    fun update(id: UUID, req: SaveSessionRequest): SessionDetail {
        val s = load(id)
        req.messages?.let { s.messages = mapper.writeValueAsString(it) }
        // title: 명시값 있으면 반영, 없고 아직 기본이면 메시지에서 자동
        val explicit = req.title?.trim()
        if (!explicit.isNullOrEmpty()) s.title = explicit.take(300)
        else if (s.title.isBlank() || s.title == "새 대화") s.title = resolveTitle(null, req.messages ?: parse(s.messages))
        return detail(repo.saveAndFlush(s)) // @UpdateTimestamp 갱신값을 즉시 반영해 반환
    }

    @Transactional
    fun delete(id: UUID) = repo.delete(load(id))

    // --- 내부 ---

    private fun load(id: UUID): AssistantSession =
        repo.findByIdAndTenantIdAndUsername(id, tenant(), user())
            .orElseThrow { NotFoundException.of("AssistantSession", id.toString()) }

    private fun detail(s: AssistantSession) = SessionDetail(s.id, s.title, parse(s.messages), s.updatedAt)

    private fun parse(s: String): JsonNode = try { mapper.readTree(s) } catch (e: Exception) { mapper.createArrayNode() }

    private fun countTurns(s: String): Int = try {
        val n = mapper.readTree(s); if (n.isArray) n.size() else 0
    } catch (e: Exception) { 0 }

    /** 제목 = 명시값 > 첫 user 메시지(40자) > "새 대화". */
    private fun resolveTitle(explicit: String?, messages: JsonNode): String {
        explicit?.trim()?.takeIf { it.isNotEmpty() }?.let { return it.take(300) }
        if (messages.isArray) {
            for (m in messages) {
                if (m.path("role").asText() == "user") {
                    val c = m.path("content").asText("").trim().replace("\n", " ")
                    if (c.isNotEmpty()) return c.take(40)
                }
            }
        }
        return "새 대화"
    }

    private fun tenant(): String = TenantContext.getTenantId()
    private fun user(): String {
        val auth = SecurityContextHolder.getContext().authentication
        return if (auth is JwtAuthenticationToken) auth.name else "dev"
    }
}
