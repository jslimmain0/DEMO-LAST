package com.flowlink.plugin

import com.flowlink.core.domain.PluginScript
import com.flowlink.core.repository.PluginScriptRepository
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.autoconfigure.jdbc.AutoConfigureTestDatabase
import org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest
import org.springframework.test.context.TestPropertySource

@DataJpaTest
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@TestPropertySource(properties = [
    "spring.datasource.url=jdbc:h2:mem:pluginscript;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE",
    "spring.datasource.driver-class-name=org.h2.Driver",
    "spring.datasource.username=sa",
    "spring.datasource.password=",
    "spring.jpa.hibernate.ddl-auto=create-drop",
])
class PluginScriptRepositoryTest {
    @Autowired lateinit var repo: PluginScriptRepository

    @Test
    fun `저장 - 초안만 있으면 live 없음, 승인본 조회는 liveSource 있는 행만`() {
        val a = repo.save(PluginScript.create("default", "aes-card", "카드 AES", "transform", "({})", "alice"))
        val b = repo.save(PluginScript.create("default", "mask", "마스킹", "transform", "({})", "alice").also { it.liveSource = "({ live })"; it.status = PluginScript.STATUS_APPROVED })
        assertThat(a.status).isEqualTo(PluginScript.STATUS_DRAFT); assertThat(a.liveSource).isNull(); assertThat(a.createdAt).isNotNull()
        assertThat(repo.findByLiveSourceIsNotNull().map { it.pluginId }).containsExactly("mask")
        assertThat(repo.existsByTenantIdAndPluginId("default", "aes-card")).isTrue()
        assertThat(repo.countByTenantIdAndStatus("default", PluginScript.STATUS_DRAFT)).isEqualTo(1)
        assertThat(repo.findByIdAndTenantId(b.id, "other")).isEmpty()
    }
}
