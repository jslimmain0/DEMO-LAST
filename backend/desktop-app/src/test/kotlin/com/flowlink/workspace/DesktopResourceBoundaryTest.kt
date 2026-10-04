package com.flowlink.workspace

import com.flowlink.common.error.ForbiddenException
import com.flowlink.core.domain.Environment
import com.flowlink.core.domain.Secret
import com.flowlink.core.repository.EnvironmentRepository
import com.flowlink.core.repository.SecretRepository
import com.flowlink.environment.EnvironmentService
import com.flowlink.mock.MockDtos
import com.flowlink.mock.MockServerService
import com.flowlink.mock.TcpMockRegistry
import com.flowlink.secret.SecretService
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
    "spring.datasource.url=jdbc:h2:mem:desktop-resource-boundary;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE",
    "spring.jpa.hibernate.ddl-auto=create-drop", "server.port=18187",
    "flowlink.desktop.data-dir=\${java.io.tmpdir}/flowlink-resource-test-\${random.uuid}",
    "flowlink.desktop.tray=false", "flowlink.desktop.open-browser=false",
])
class DesktopResourceBoundaryTest {
    @Autowired lateinit var ws: WorkspaceService
    @Autowired lateinit var environments: EnvironmentService
    @Autowired lateinit var envRepo: EnvironmentRepository
    @Autowired lateinit var secrets: SecretService
    @Autowired lateinit var secretRepo: SecretRepository
    @Autowired lateinit var mocks: MockServerService
    @Autowired lateinit var tcp: TcpMockRegistry
    @Autowired lateinit var migration: ResourceSchemaMigration

    @Test fun `기존 개인 공통 자원을 H2 개인 공간에 보존하고 공개 공간 및 공개 리슨을 차단한다`() {
        val personal = ws.listMine().single()
        envRepo.saveAndFlush(Environment.create("default", "legacy", "{\"origin\":\"PC\"}"))
        secretRepo.saveAndFlush(Secret.create("default", "legacy", "ciphertext-not-read", "*"))
        migration.migrate()
        assertThat(environments.list().single { it.name == "legacy" }.workspaceId).isEqualTo(personal.id)
        assertThat(environments.vars("legacy")).containsEntry("origin", "PC")
        assertThat(secrets.listNames().single { it.name == "legacy" }.workspaceId).isEqualTo(personal.id)
        assertThrows<ForbiddenException> { environments.list("public") }
        assertThrows<ForbiddenException> { secrets.put("bad", "value", null, "public") }
        assertThat(tcp.effectiveBindAddress()).isEqualTo("127.0.0.1")
        val mock = mocks.create(MockDtos.CreateMockServerRequest("개인", "personal-listener", "HTTP"))
        assertThat(mock.listener!!.agent).isEqualTo("local")
        assertThat(mock.listener!!.bindAddress).startsWith("127.0.0.1:")
        assertThat(mock.workspaceId.toString()).isEqualTo(personal.id)
        assertThat(mocks.findForServingWorkspace("public", mock.slug)).isEmpty
        assertThat(mocks.findForServing("default", mock.slug).get().id).isEqualTo(mock.id)
    }
}
