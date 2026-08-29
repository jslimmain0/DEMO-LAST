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
    @Autowired lateinit var execService: com.flowlink.execution.ExecutionService
    @Autowired lateinit var userRepo: com.flowlink.core.repository.AppUserRepository

    @AfterEach
    fun clear() = SecurityContextHolder.clearContext()

    private fun asUser(name: String) {
        val jwt = Jwt.withTokenValue("t").header("alg", "none")
            .claim("preferred_username", name).subject(name).build()
        SecurityContextHolder.getContext().authentication = JwtAuthenticationToken(jwt)
    }

    /** 가입 승인 시뮬레이션 — 관리 콘솔의 [✓ 승인]에 해당(로그인=신청 → 승인 후 개인 ws/팀 생성 가능). */
    private fun approveUser(name: String) {
        val t = com.flowlink.common.tenant.TenantContext.SHARED_FLOW_TENANT
        val u = userRepo.findByTenantIdAndUsername(t, name)
            .orElseGet { userRepo.save(com.flowlink.core.domain.AppUser.of(t, name)) }
        u.status = com.flowlink.core.domain.AppUser.STATUS_APPROVED
        userRepo.save(u)
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
        approveUser("alice")
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
        approveUser("alice")
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
        approveUser("alice")
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
        approveUser("alice")
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
    fun `실행 레이어 게이트 - VIEWER 실행 403, 비멤버 이력 조회 403, 이력 워크스페이스 스코프`() {
        asUser("alice")
        approveUser("alice")
        val team = ws.createTeam("실행팀")
        val teamId = UUID.fromString(team.id)
        ws.putMember(teamId, "bob", WorkspaceMember.ROLE_VIEWER)
        val flow = flowService.create(CreateFlowRequest("실행 플로우", null, null, team.id))

        asUser("bob") // VIEWER — 실행 불가(조회만)
        assertThrows(ForbiddenException::class.java) { execService.run(flow.id, null) }
        assertThrows(ForbiddenException::class.java) { execService.runSingleNode(flow.id, "n1") }
        execService.listFiltered(null, null, null, null, 10, 0, team.id) // 이력 조회는 허용

        asUser("mallory") // 비멤버 — 이력 조회부터 403 (워크스페이스 지정/flowId 직접 지정 모두)
        assertThrows(ForbiddenException::class.java) { execService.listFiltered(null, null, null, null, 10, 0, team.id) }
        assertThrows(ForbiddenException::class.java) { execService.listFiltered(null, flow.id, null, null, 10, 0, null) }
        assertThrows(ForbiddenException::class.java) { execService.listForFlow(flow.id, 10) }

        asUser("alice") // 스코프 분리 — 공용 스코프 이력엔 팀 flow 실행이 안 섞인다(빈 결과여도 호출 자체는 성공)
        assertTrue(execService.listFiltered(null, null, null, null, 10, 0, null).none { it.flowId == flow.id })
        assertTrue(execService.listFiltered(null, null, null, null, 10, 0, team.id).isEmpty())
    }

    @Test
    fun `가입 신청 승인 모델 - 신규 활동은 PENDING, 승인 전엔 개인 ws·팀 생성 불가, 차단은 미승인`() {
        val t = com.flowlink.common.tenant.TenantContext.SHARED_FLOW_TENANT
        asUser("newbie")
        ws.touchUser("newbie") // 첫 활동 = 가입 신청(PENDING) 자동 등록
        val row = userRepo.findByTenantIdAndUsername(t, "newbie").get()
        assertEquals(com.flowlink.core.domain.AppUser.STATUS_PENDING, row.effectiveStatus())

        assertFalse(ws.isApproved("newbie"))
        assertNull(ws.ensurePersonal("newbie")) // 승인 전 — 개인 워크스페이스 없음(공용만)
        assertThrows(ForbiddenException::class.java) { ws.createTeam("몰래팀") } // 팀 생성 불가

        approveUser("newbie") // 관리자 승인
        assertTrue(ws.isApproved("newbie"))
        assertTrue(ws.ensurePersonal("newbie") != null)

        row.status = com.flowlink.core.domain.AppUser.STATUS_BLOCKED // 차단 → 미승인 취급
        userRepo.save(row)
        assertFalse(ws.isApproved("newbie"))

        assertTrue(ws.isApproved("dev")) // dev/관리자는 항상 승인
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
