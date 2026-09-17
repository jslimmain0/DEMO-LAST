package com.flowlink.plugin

import com.flowlink.core.domain.Flow
import com.flowlink.core.domain.FlowVersion
import com.flowlink.core.domain.MockServer
import com.flowlink.core.domain.Protocol
import com.flowlink.core.repository.FlowRepository
import com.flowlink.core.repository.FlowVersionRepository
import com.flowlink.core.repository.MockServerRepository
import com.flowlink.core.repository.ProtocolRepository
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.test.context.TestPropertySource

@SpringBootTest
@TestPropertySource(properties = [
    "spring.datasource.url=jdbc:h2:mem:pluginusage;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE",
    "spring.datasource.driver-class-name=org.h2.Driver",
    "spring.datasource.username=sa",
    "spring.datasource.password=",
    "spring.jpa.hibernate.ddl-auto=create-drop",
])
class PluginUsageIndexTest {
    @Autowired lateinit var index: PluginUsageIndex
    @Autowired lateinit var flowRepo: FlowRepository
    @Autowired lateinit var versionRepo: FlowVersionRepository
    @Autowired lateinit var mockRepo: MockServerRepository
    @Autowired lateinit var protocolRepo: ProtocolRepository

    @Test
    fun `워크플로 transformId · Mock 코덱 step id · 프로토콜 필드 plugin id 를 찾는다`() {
        val t = "default"
        val f = flowRepo.save(Flow.create(t, "결제 플로우", null))
        val graph = """{"nodes":[{"id":"n1","type":"transform","transformId":"aes-card"}],"edges":[]}"""
        versionRepo.save(FlowVersion.create(f.id, 1, "v1", graph, null, "alice")); f.currentVersion = 1; flowRepo.save(f)
        mockRepo.save(MockServer.create(t, "pay mock", "paym", MockServer.Kind.CUSTOM, """{"routes":[{"id":"r1","codec":{"response":[{"id":"aes-card","target":"fields","fields":["no"]}]}}]}"""))
        protocolRepo.save(Protocol.create(t, "코어뱅킹", """{"messages":[{"key":"0210","fields":[{"name":"계좌","len":13,"plugin":{"id":"acct-enc"}}]}]}"""))
        index.invalidate()
        assertThat(index.refs("aes-card").map { it.kind to it.name }).containsExactlyInAnyOrder("flow" to "결제 플로우", "mock" to "pay mock")
        assertThat(index.refs("acct-enc").map { it.kind }).containsExactly("protocol")
        assertThat(index.count("nobody")).isZero()
    }
}
