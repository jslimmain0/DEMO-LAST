package com.flowlink.workspace

import com.flowlink.common.error.BadRequestException
import com.flowlink.common.error.ForbiddenException
import com.flowlink.core.domain.Workspace
import com.flowlink.core.domain.WorkspaceMember
import com.flowlink.core.repository.FlowRepository
import com.flowlink.definition.FlowService
import com.flowlink.definition.dto.CreateFlowRequest
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.security.oauth2.jwt.Jwt
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken
import org.springframework.test.context.TestPropertySource
import java.util.UUID

/**
 * 워크스페이스 롤 게이트 — dev 모드 API 로는 non-admin 경로를 못 만들므로(항상 'dev'=ADMIN)
 * SecurityContext 에 JWT 를 직접 심어 alice/bob 등 일반 사용자의 롤 강제를 검증한다.
 * (스키마: H2 인메모리 + create-drop, Flyway off — GuestModeSecurityTest 와 동일 관례.)
 */
@SpringBootTest
@TestPropertySource(properties = [
    "spring.datasource.url=jdbc:h2:mem:wsrbac;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE",
    "spring.datasource.driver-class-name=org.h2.Driver",
    "spring.datasource.username=sa",
    "spring.datasource.password=",
    "spring.flyway.enabled=false",
    "spring.jpa.hibernate.ddl-auto=create-drop",
])
class WorkspaceRbacTest {

    @Autowired lateinit var ws: WorkspaceService
    @Autowired lateinit var flowService: FlowService
    @Autowired lateinit var flowRepo: FlowRepository

    @AfterEach
    fun clear() = SecurityContextHolder.clearContext()

    private fun asUser(name: String) {
        val jwt = Jwt.withTokenValue("t").header("alg", "none")
            .claim("preferred_username", name).subject(name).build()
        SecurityContextHolder.getContext().authentication = JwtAuthenticationToken(jwt)
    }

    @Test
    fun `공용(null)은 누구나 EDITOR - dev 모드 무토큰은 dev(ADMIN)`() {
        assertEquals("dev", ws.currentUsername())
        assertTrue(ws.isAdmin("dev"))
        assertEquals(WorkspaceMember.ROLE_EDITOR, ws.roleFor("anyone", null))
    }

    @Test
    fun `개인 워크스페이스 - 소유자만 접근, 타인은 403, 관리자는 열람`() {
        asUser("alice")
        val personal = ws.ensurePersonal("alice")!!
        assertEquals(Workspace.KIND_PERSONAL, personal.kind)
        assertEquals(WorkspaceMember.ROLE_OWNER, ws.roleFor("alice", personal.id))
        assertNull(ws.roleFor("bob", personal.id))
        assertThrows(ForbiddenException::class.java) { ws.requireRead("bob", personal.id) }
        assertEquals(WorkspaceMember.ROLE_OWNER, ws.roleFor("dev", personal.id)) // dev=ADMIN
        // 재호출은 새로 만들지 않는다(멱등)
        assertEquals(personal.id, ws.ensurePersonal("alice")!!.id)
    }

    @Test
    fun `팀 워크스페이스 - 멤버십 롤과 VIEWER 쓰기 차단`() {
        asUser("alice")
        val team = ws.createTeam("결제팀")
        val teamId = UUID.fromString(team.id)
        ws.putMember(teamId, "bob", WorkspaceMember.ROLE_VIEWER)
        ws.putMember(teamId, "carol", WorkspaceMember.ROLE_EDITOR)

        assertEquals(WorkspaceMember.ROLE_OWNER, ws.roleFor("alice", teamId))
        assertEquals(WorkspaceMember.ROLE_VIEWER, ws.roleFor("bob", teamId))
        ws.requireRead("bob", teamId) // 조회는 허용
        assertThrows(ForbiddenException::class.java) { ws.requireWrite("bob", teamId) }
        ws.requireWrite("carol", teamId)
        assertNull(ws.roleFor("mallory", teamId))
        assertThrows(ForbiddenException::class.java) { ws.requireRead("mallory", teamId) }
    }

    @Test
    fun `멤버 관리는 OWNER 만 - 마지막 OWNER 는 못 내보낸다`() {
        asUser("alice")
        val teamId = UUID.fromString(ws.createTeam("운영팀").id)
        ws.putMember(teamId, "bob", WorkspaceMember.ROLE_EDITOR)

        asUser("bob") // EDITOR 는 멤버 관리 불가
        assertThrows(ForbiddenException::class.java) { ws.putMember(teamId, "carol", WorkspaceMember.ROLE_VIEWER) }

        asUser("alice")
        assertThrows(BadRequestException::class.java) { ws.removeMember(teamId, "alice") } // 마지막 OWNER
        ws.removeMember(teamId, "bob")
        assertNull(ws.roleFor("bob", teamId))
    }

    @Test
    fun `플로우 워크스페이스 격리 - VIEWER 저장 403, 비멤버 조회 403, 삭제 시 공용 승격`() {
        asUser("alice")
        val team = ws.createTeam("보안팀")
        val teamId = UUID.fromString(team.id)
        ws.putMember(teamId, "bob", WorkspaceMember.ROLE_VIEWER)

        val flow = flowService.create(CreateFlowRequest("팀 플로우", null, null, team.id))
        // 목록 격리: 팀 스코프에는 있고 공용 목록에는 없다
        assertTrue(flowService.list(team.id).any { it.id == flow.id })
        assertFalse(flowService.list(null).any { it.id == flow.id })

        asUser("bob") // VIEWER — 읽기 OK, 쓰기 403
        flowService.get(flow.id)
        assertThrows(ForbiddenException::class.java) { flowService.updateMeta(flow.id, "이름 변경", null) }

        asUser("mallory") // 비멤버 — 조회부터 403
        assertThrows(ForbiddenException::class.java) { flowService.get(flow.id) }
        assertThrows(ForbiddenException::class.java) { flowService.list(team.id) }

        asUser("alice") // 삭제 → 안의 플로우는 공용으로 승격
        ws.delete(teamId)
        assertNull(flowRepo.findById(flow.id).get().workspaceId)
        assertTrue(flowService.list(null).any { it.id == flow.id })
    }

    @Test
    fun `resolveId - public과 빈 값은 null, 엉뚱한 값은 400`() {
        assertNull(ws.resolveId(null))
        assertNull(ws.resolveId("public"))
        assertNull(ws.resolveId("  "))
        val u = UUID.randomUUID()
        assertEquals(u, ws.resolveId(u.toString()))
        assertThrows(BadRequestException::class.java) { ws.resolveId("not-a-uuid") }
    }
}
