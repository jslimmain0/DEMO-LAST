package com.flowlink.desktop

import com.flowlink.common.error.ForbiddenException
import com.flowlink.common.tenant.TenantContext
import com.flowlink.core.domain.Workspace
import com.flowlink.core.repository.*
import com.flowlink.definition.FlowService
import com.flowlink.definition.dto.CreateFlowRequest
import com.flowlink.workspace.WorkspaceService
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.test.context.ActiveProfiles
import org.springframework.test.context.TestPropertySource

@SpringBootTest
@ActiveProfiles("local", "desktop")
@TestPropertySource(properties = [
    "spring.datasource.url=jdbc:h2:mem:desktop-boundary;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE",
    "spring.jpa.hibernate.ddl-auto=create-drop", "server.port=18183",
    "flowlink.desktop.data-dir=\${java.io.tmpdir}/flowlink-desktop-test-\${random.uuid}",
    "flowlink.desktop.tray=false", "flowlink.desktop.open-browser=false",
])
class DesktopWorkspaceTest {
    @Autowired lateinit var workspace: WorkspaceService
    @Autowired lateinit var flows: FlowService
    @Autowired lateinit var flowRepo: FlowRepository
    @Autowired lateinit var wsRepo: WorkspaceRepository
    @Autowired lateinit var mocks: com.flowlink.mock.MockServerService
    @Autowired lateinit var mockRepo: MockServerRepository
    @Autowired lateinit var executions: com.flowlink.execution.ExecutionService

    @Test fun `PC는 개인 H2 공간만 제공하고 구 미분류 데이터도 같은 개인 공간에 보존한다`() {
        val personal = workspace.listMine().single()
        assertThat(personal.kind).isEqualTo("PERSONAL")
        assertThat(workspace.resolveId(null).toString()).isEqualTo(personal.id)
        assertThrows<ForbiddenException> { workspace.resolveId("public") }
        assertThrows<ForbiddenException> { workspace.createTeam("로컬에서 만들 수 없는 팀") }
        val team = wsRepo.save(Workspace.team(TenantContext.SHARED_FLOW_TENANT, "구 로컬 팀"))
        assertThat(workspace.roleFor("dev", team.id)).isNull()
        assertThat(workspace.supportsWorkspace(team.id)).isFalse()

        val flow = flows.create(CreateFlowRequest("구 개인 플로우", null, null, null))
        val saved = flowRepo.findById(flow.id).orElseThrow()
        saved.workspaceId = null; flowRepo.saveAndFlush(saved)
        val mock = mocks.create(com.flowlink.mock.MockDtos.CreateMockServerRequest("구 개인 목", "desktop-migration", "HTTP", null))
        val savedMock = mockRepo.findById(mock.id).orElseThrow()
        savedMock.workspaceId = null; mockRepo.saveAndFlush(savedMock)
        assertThat(mocks.findForServing(TenantContext.SHARED_FLOW_TENANT, savedMock.slug)).isEmpty()
        workspace.initializeLocalWorkspace()
        assertThat(flowRepo.findById(flow.id).orElseThrow().workspaceId.toString()).isEqualTo(personal.id)
        assertThat(mockRepo.findById(mock.id).orElseThrow().workspaceId.toString()).isEqualTo(personal.id)
        assertThat(flows.list("local")).anyMatch { it.id == flow.id }
        assertThat(mocks.fleet().workspaces).allMatch { it.kind == "PERSONAL" }

        val foreign = flowRepo.findById(flow.id).orElseThrow()
        foreign.workspaceId = team.id; flowRepo.saveAndFlush(foreign)
        assertThrows<ForbiddenException> { executions.run(flow.id, null, com.flowlink.core.domain.TriggerType.WEBHOOK) }
        assertThrows<ForbiddenException> { workspace.delete(java.util.UUID.fromString(personal.id)) }
    }
}
