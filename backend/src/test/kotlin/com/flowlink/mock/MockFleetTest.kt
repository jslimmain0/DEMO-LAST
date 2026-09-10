package com.flowlink.mock

import com.flowlink.core.domain.WorkspaceMember
import com.flowlink.workspace.WorkspaceService
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
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
 * 서버 현황(fleet) — 모든 워크스페이스의 Mock 을 한 번에 돌려주되, 접근 권한이 없는 워크스페이스의 Mock 은
 * "무엇이 떠 있는지"(이름·종류·켜짐·포트·살아있음)만 보이고 정의 내용(라우트 목록·환경)은 비운다.
 * 그룹핑 mine 은 멤버십 기준, 편집 가능 여부는 myRole. 포트 맵은 실제 리스너 상태.
 * (WorkspaceRbacTest 와 같은 JWT 심기 관례 — dev 모드 API 로는 non-admin 을 만들 수 없다.)
 */
@SpringBootTest
@TestPropertySource(properties = [
    "spring.datasource.url=jdbc:h2:mem:mockfleet;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE",
    "spring.datasource.driver-class-name=org.h2.Driver",
    "spring.datasource.username=sa",
    "spring.datasource.password=",
    "spring.flyway.enabled=false",
    "spring.jpa.hibernate.ddl-auto=create-drop",
])
class MockFleetTest {

    @Autowired lateinit var ws: WorkspaceService
    @Autowired lateinit var mockService: MockServerService
    @Autowired lateinit var userRepo: com.flowlink.core.repository.AppUserRepository
    @Autowired lateinit var tcpRegistry: TcpMockRegistry

    @AfterEach
    fun clear() = SecurityContextHolder.clearContext()

    private fun asUser(name: String) {
        val jwt = Jwt.withTokenValue("t").header("alg", "none")
            .claim("preferred_username", name).subject(name).build()
        SecurityContextHolder.getContext().authentication = JwtAuthenticationToken(jwt)
    }

    private fun approveUser(name: String) {
        val t = com.flowlink.common.tenant.TenantContext.SHARED_FLOW_TENANT
        val u = userRepo.findByTenantIdAndUsername(t, name)
            .orElseGet { userRepo.save(com.flowlink.core.domain.AppUser.of(t, name)) }
        u.status = com.flowlink.core.domain.AppUser.STATUS_APPROVED
        userRepo.save(u)
    }

    @Test
    fun `fleet - 접근 불가 워크스페이스는 이름·포트·상태만, 멤버는 정의까지, mine 은 멤버십 기준`() {
        asUser("alice"); approveUser("alice")
        val team = ws.createTeam("플릿팀")
        val teamId = UUID.fromString(team.id)
        ws.putMember(teamId, "bob", WorkspaceMember.ROLE_VIEWER)
        val teamMock = mockService.create(MockDtos.CreateMockServerRequest("팀 결제", "fleet-team-pay", "HTTP", team.id))
        val publicTcp = mockService.create(MockDtos.CreateMockServerRequest("공용 전문", "fleet-public-tcp", "TCP", null))
        val tcpPort = mockService.parseSpec(mockService.get(publicTcp.id).spec.toString()).tcp!!.port!!
        try {
            // --- 비멤버 mallory: 팀 워크스페이스는 목록에 있으나 myRole=null, 팀 Mock 은 readable=false + 라우트 비움
            asUser("mallory")
            val f = mockService.fleet()
            val teamWs = f.workspaces.first { it.id == team.id }
            assertNull(teamWs.myRole); assertFalse(teamWs.mine); assertEquals("TEAM", teamWs.kind)
            val pub = f.workspaces.first { it.id == WorkspaceService.PUBLIC_ID }
            assertTrue(pub.mine); assertEquals(WorkspaceMember.ROLE_EDITOR, pub.myRole)
            val tm = f.servers.first { it.id == teamMock.id }
            assertFalse(tm.readable); assertNull(tm.myRole); assertEquals(team.id, tm.workspaceId)
            assertEquals("팀 결제", tm.name); assertEquals("fleet-team-pay", tm.slug); assertTrue(tm.enabled)
            assertTrue(tm.routeLabels.isEmpty(), "접근 불가 Mock 의 라우트 목록은 비어야 한다")
            assertEquals(1, tm.routeCount) // 개수는 노출(무엇이 떠 있는지)
            // 공용 TCP: 읽기 가능 + 실제 리스너 열림 + 포트 맵 LISTENING
            val pt = f.servers.first { it.id == publicTcp.id }
            assertTrue(pt.readable); assertTrue(pt.listening); assertEquals(tcpPort, pt.tcpPort); assertNull(pt.listenError)
            val portRow = f.ports.first { it.kind == "TCP" && it.mockId == publicTcp.id }
            assertEquals("LISTENING", portRow.state); assertEquals(tcpPort, portRow.port)
            val http = f.ports.first { it.kind == "HTTP" }
            assertEquals(f.httpPort, http.port); assertTrue(http.count >= 1)

            // --- VIEWER bob: 팀 Mock 정의 보임(readable), 롤 VIEWER, 멤버라 mine
            asUser("bob")
            val fb = mockService.fleet()
            val tmB = fb.servers.first { it.id == teamMock.id }
            assertTrue(tmB.readable); assertEquals(WorkspaceMember.ROLE_VIEWER, tmB.myRole)
            assertEquals(listOf("GET /hello"), tmB.routeLabels)
            assertTrue(fb.workspaces.first { it.id == team.id }.mine)

            // --- OWNER alice
            asUser("alice")
            val fa = mockService.fleet()
            assertEquals(WorkspaceMember.ROLE_OWNER, fa.servers.first { it.id == teamMock.id }.myRole)

            // --- TCP 끄면 리스너 닫힘 → 포트 맵 OFF, listenError 없음(의도된 꺼짐)
            mockService.updateMeta(publicTcp.id, MockDtos.UpdateMockServerRequest(null, false))
            val off = mockService.fleet()
            val ptOff = off.servers.first { it.id == publicTcp.id }
            assertFalse(ptOff.listening); assertNull(ptOff.listenError); assertNull(tcpRegistry.listeningPort(publicTcp.id))
            assertEquals("OFF", off.ports.first { it.kind == "TCP" && it.mockId == publicTcp.id }.state)
        } finally {
            asUser("alice")
            runCatching { mockService.delete(teamMock.id) }
            runCatching { mockService.delete(publicTcp.id) }
        }
    }
}
