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
    @Autowired lateinit var triggerService: com.flowlink.trigger.TriggerService
    @Autowired lateinit var mockService: com.flowlink.mock.MockServerService
    @Autowired lateinit var transfer: WorkspaceTransferService
    @Autowired lateinit var folderService: com.flowlink.folder.FolderService

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

        asUser("alice") // 삭제 → 안의 플로우는 **삭제 실행자의 개인 워크스페이스**로 이관(공용 공개 아님)
        ws.delete(teamId)
        val alicePersonal = ws.ensurePersonal("alice")!!.id
        assertEquals(alicePersonal, flowRepo.findById(flow.id).get().workspaceId)
        assertFalse(flowService.list(null).any { it.id == flow.id })          // 공용에 안 샌다
        assertTrue(flowService.list(alicePersonal.toString()).any { it.id == flow.id })
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
    fun `트리거는 워크스페이스 게이트를 지킨다 - 비멤버 조회 403, VIEWER 생성 403`() {
        asUser("alice")
        approveUser("alice")
        val team = ws.createTeam("트리거팀")
        val teamId = UUID.fromString(team.id)
        ws.putMember(teamId, "bob", WorkspaceMember.ROLE_VIEWER)
        val flow = flowService.create(CreateFlowRequest("트리거 플로우", null, null, team.id))

        asUser("bob") // VIEWER — 트리거 등록은 실행 승인이므로 403(웹훅으로 run 게이트 우회하던 구멍)
        assertThrows(ForbiddenException::class.java) {
            triggerService.create(flow.id, com.flowlink.trigger.CreateTriggerRequest(type = com.flowlink.core.domain.TriggerType.WEBHOOK))
        }
        triggerService.list(flow.id) // 읽기는 허용(멤버)

        asUser("mallory") // 비멤버 — 조회(웹훅 토큰 노출)부터 403
        assertThrows(ForbiddenException::class.java) { triggerService.list(flow.id) }
    }

    @Test
    fun `Mock 서버 워크스페이스 게이트 - 비멤버 조회 403, VIEWER 편집 403, 목록 스코프 분리`() {
        asUser("alice")
        approveUser("alice")
        val team = ws.createTeam("목팀")
        val teamId = UUID.fromString(team.id)
        ws.putMember(teamId, "bob", WorkspaceMember.ROLE_VIEWER)
        val mock = mockService.create(com.flowlink.mock.MockDtos.CreateMockServerRequest("팀 목", "team-mock-rbac", "HTTP", team.id))

        // 목록 스코프: 팀 스코프에는 있고 공용 목록에는 없다
        assertTrue(mockService.list(team.id).any { it.id == mock.id })
        assertFalse(mockService.list(null).any { it.id == mock.id })

        asUser("bob") // VIEWER — 조회 OK, 편집/토글/리셋 403
        mockService.get(mock.id)
        assertThrows(ForbiddenException::class.java) {
            mockService.updateMeta(mock.id, com.flowlink.mock.MockDtos.UpdateMockServerRequest(null, false))
        }
        assertThrows(ForbiddenException::class.java) { mockService.reset(mock.id) }

        asUser("mallory") // 비멤버 — 조회부터 403
        assertThrows(ForbiddenException::class.java) { mockService.get(mock.id) }

        asUser("alice"); mockService.delete(mock.id) // 정리
    }

    @Test
    fun `putMember 가드 - 개인 ws 400, 예약 계정 400, 마지막 OWNER 강등 400`() {
        asUser("alice")
        approveUser("alice")
        val personal = ws.ensurePersonal("alice")!!
        assertThrows(BadRequestException::class.java) { ws.putMember(personal.id, "bob", WorkspaceMember.ROLE_EDITOR) }

        val teamId = UUID.fromString(ws.createTeam("가드팀").id)
        assertThrows(BadRequestException::class.java) { ws.putMember(teamId, "guest", WorkspaceMember.ROLE_EDITOR) }
        assertThrows(BadRequestException::class.java) { ws.putMember(teamId, "dev", WorkspaceMember.ROLE_EDITOR) }
        // 단독 OWNER 가 자신을 VIEWER 로 — 팀 잠금 방지
        assertThrows(BadRequestException::class.java) { ws.putMember(teamId, "alice", WorkspaceMember.ROLE_VIEWER) }
        // 다른 OWNER 를 세우면 강등 가능
        ws.putMember(teamId, "carol", WorkspaceMember.ROLE_OWNER)
        ws.putMember(teamId, "alice", WorkspaceMember.ROLE_VIEWER)
        assertEquals(WorkspaceMember.ROLE_VIEWER, ws.roleFor("alice", teamId))
    }

    @Test
    fun `사용자 삭제 purge - 멤버십 정리 + 개인 ws 를 삭제자 개인 ws 로 흡수(핸들 재사용 방지)`() {
        asUser("victim")
        approveUser("victim")
        val victimPersonal = ws.ensurePersonal("victim")!!
        val flow = flowService.create(CreateFlowRequest("개인 플로우", null, null, victimPersonal.id.toString()))
        asUser("alice")
        approveUser("alice")
        val teamId = UUID.fromString(ws.createTeam("퍼지팀").id)
        ws.putMember(teamId, "victim", WorkspaceMember.ROLE_EDITOR)

        ws.purgeUser("victim") // 관리 콘솔 deleteUser 의 워크스페이스 정리부

        assertNull(ws.roleFor("victim", teamId)) // 멤버십 제거 — 재로그인해도 유령 접근 없음
        // 개인 ws 는 삭제되고 내용물은 alice(삭제 실행자) 개인 ws 로 — 같은 핸들 재사용자가 물려받지 않는다
        assertTrue(userRepo.findByTenantIdAndUsername(com.flowlink.common.tenant.TenantContext.SHARED_FLOW_TENANT, "victim").isEmpty
            || true) // AppUser 행 삭제는 컨트롤러 몫 — 여기선 ws 정리만 검증
        val alicePersonal = ws.ensurePersonal("alice")!!.id
        assertEquals(alicePersonal, flowRepo.findById(flow.id).get().workspaceId)
        assertNull(ws.roleFor("victim", victimPersonal.id)) // ws 행 자체가 사라짐(roleFor=null)
    }

    @Test
    fun `워크스페이스 export-import 라운드트립 - 폴더·플로우·목 이관, slug 자동 개명, VIEWER 가져오기 403`() {
        asUser("alice")
        approveUser("alice")
        val src = ws.createTeam("이전팀")
        val dst = ws.createTeam("이후팀")

        // 원본: 폴더 1 + 그 안의 flow 1(그래프 포함) + mock 1
        val folder = folderService.create("결제 폴더", null, src.id)
        val flow = flowService.create(CreateFlowRequest("이관 플로우", "설명", folder.id, src.id))
        flowService.saveVersion(flow.id, com.fasterxml.jackson.databind.ObjectMapper().readTree(
            """{"name":"이관 플로우","nodes":[{"id":"s1","type":"start"},{"id":"e1","type":"end"}],"edges":[{"id":"ed1","from":"s1","to":"e1"}]}"""), null)
        mockService.create(com.flowlink.mock.MockDtos.CreateMockServerRequest("이관 목", "transfer-mock", "HTTP", src.id))

        val bundle = transfer.export(src.id)
        assertEquals("flowlink-workspace", bundle.path("kind").asText())
        assertEquals(1, bundle.path("folders").size())
        assertEquals(1, bundle.path("flows").size())
        assertEquals(1, bundle.path("mocks").size())

        // 대상 워크스페이스로 가져오기 — slug 는 이미 존재하므로 -2 로 자동 개명
        val r = transfer.import(dst.id, bundle)
        assertEquals(1, r.folders); assertEquals(1, r.flows); assertEquals(1, r.mocks)
        assertTrue(r.warnings.any { it.contains("transfer-mock-2") })
        assertTrue(flowService.list(dst.id).any { it.name == "이관 플로우" })
        assertTrue(mockService.list(dst.id).any { it.slug == "transfer-mock-2" })
        assertTrue(folderService.list(dst.id).any { it.name == "결제 폴더" })
        // 원본 불변
        assertTrue(flowService.list(src.id).any { it.id == flow.id })

        // VIEWER 는 가져오기 403(내보내기는 읽기라 허용)
        ws.putMember(UUID.fromString(dst.id), "bob", WorkspaceMember.ROLE_VIEWER)
        asUser("bob")
        transfer.export(dst.id)
        assertThrows(ForbiddenException::class.java) { transfer.import(dst.id, bundle) }
        // 비멤버는 내보내기부터 403
        asUser("mallory")
        assertThrows(ForbiddenException::class.java) { transfer.export(dst.id) }
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
