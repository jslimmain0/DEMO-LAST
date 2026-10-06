package com.flowlink.mock

import com.fasterxml.jackson.databind.ObjectMapper
import com.flowlink.definition.FlowService
import com.flowlink.definition.dto.CreateFlowRequest
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.test.context.TestPropertySource

/** Mock 정의 버전 스냅샷(저장/복원/📌)·목록 요약(라우트/메서드)·사용처(워크플로 그래프 스캔). */
@SpringBootTest
@TestPropertySource(properties = [
    "spring.datasource.url=jdbc:h2:mem:mockver;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE",
    "spring.datasource.driver-class-name=org.h2.Driver",
    "spring.datasource.username=sa",
    "spring.datasource.password=",
    "spring.jpa.hibernate.ddl-auto=create-drop",
])
class MockServerVersionTest {

    @Autowired lateinit var service: MockServerService
    @Autowired lateinit var flowService: FlowService
    private val mapper = ObjectMapper()

    private fun spec(vararg paths: String) = mapper.readTree(
        """{"routes":[${paths.joinToString(",") { """{"id":"r-$it","method":"POST","path":"$it","rules":[{"id":"u","body":"{}"}]}""" }}]}"""
    )

    @Test
    fun `저장마다_스냅샷_같은_내용은_스킵_복원은_새_버전_핀_보존`() {
        val m = service.create(MockDtos.CreateMockServerRequest("ver", "ver-e2e", "HTTP", null))
        assertThat(m.currentVersion).isEqualTo(1) // 생성 = v1
        service.updateSpec(m.id, spec("/a"), "첫 라우트", false)
        service.updateSpec(m.id, spec("/a"), null, false) // 동일 내용 → 스냅샷 없음
        service.updateSpec(m.id, spec("/a", "/b"), null, true) // 📌
        var list = service.listVersions(m.id)
        assertThat(list.map { it.versionNo }).containsExactly(3, 2, 1)
        assertThat(list[0].pinned).isTrue(); assertThat(list[0].routeCount).isEqualTo(2)
        assertThat(list[1].note).isEqualTo("첫 라우트"); assertThat(list[1].routeCount).isEqualTo(1)
        assertThat(service.getVersionSpec(m.id, 2).get("routes").size()).isEqualTo(1)

        val restored = service.restoreVersion(m.id, 2)
        assertThat(restored.versionNo).isEqualTo(4); assertThat(restored.note).isEqualTo("v2 복원")
        val d = service.get(m.id)
        assertThat(d.currentVersion).isEqualTo(4)
        assertThat(d.spec.get("routes").size()).isEqualTo(1)

        service.setVersionPinned(m.id, 1, true)
        assertThat(service.listVersions(m.id).first { it.versionNo == 1 }.pinned).isTrue()
        // 요약
        val s = service.list().first { it.id == m.id }
        assertThat(s.routeCount).isEqualTo(1); assertThat(s.methods).containsExactly("POST"); assertThat(s.currentVersion).isEqualTo(4)
    }

    @Test
    fun `정리_최근_N개_유지_핀은_보존`() {
        val m = service.create(MockDtos.CreateMockServerRequest("prune", "ver-prune", "HTTP", null))
        service.updateSpec(m.id, spec("/keep-me"), "핀", true) // v2 📌
        for (i in 1..(MockServerService.VERSIONS_KEEP + 5)) service.updateSpec(m.id, spec("/p$i"), null, false)
        val list = service.listVersions(m.id)
        assertThat(list.size).isEqualTo(MockServerService.VERSIONS_KEEP + 1) // 최근 50 + 📌 v2
        assertThat(list.any { it.versionNo == 2 && it.pinned }).isTrue()
        assertThat(list.any { it.versionNo == 1 }).isFalse() // v1(생성)은 정리됨
    }

    @Test
    fun `사용처_워크플로_그래프에_mock_base_URL_포함`() {
        val m = service.create(MockDtos.CreateMockServerRequest("used", "ver-used", "HTTP", null))
        val other = service.create(MockDtos.CreateMockServerRequest("unused", "ver-used-2", "HTTP", null)) // 접두사 겹침 — 경계 검증
        val f = flowService.create(CreateFlowRequest("caller", null, null, null))
        val graph = mapper.readTree("""{"nodes":[{"id":"s","type":"start","name":"시작"},{"id":"h","type":"http","name":"호출","baseUrl":"http://localhost:18080/mock/ver-used","path":"/x"}],"edges":[{"from":"s","to":"h"}]}""")
        flowService.saveVersion(f.id, graph, null)
        val u = service.usages(null)
        assertThat(u[m.id]?.map { it.id }).containsExactly(f.id)
        assertThat(u[other.id]).isNull()
    }
}
