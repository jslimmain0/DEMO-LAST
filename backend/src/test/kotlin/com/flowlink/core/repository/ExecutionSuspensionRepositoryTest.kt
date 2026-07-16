package com.flowlink.core.repository

import com.flowlink.core.domain.ExecutionSuspension
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.autoconfigure.jdbc.AutoConfigureTestDatabase
import org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest
import org.springframework.boot.test.autoconfigure.orm.jpa.TestEntityManager
import org.springframework.test.context.TestPropertySource
import java.util.UUID

/**
 * claim CAS(이중 재개 방지)의 핵심 계약을 못박는다 — 조건부 DELETE 가 pending_node_id 까지 일치할 때만
 * 삭제하고, 영향 행수가 그 조건을 정확히 반영한다. (파생 deleteBy… 는 PK 로만 지워 이 성질이 깨졌었다.)
 * 동시성 인터리빙 자체는 e2e(재시작 내구성)로 커버.
 *
 * 스키마: 앱과 동일하게 H2(PostgreSQL 모드)를 Hibernate create-drop 로(Flyway 는 vendor 디렉터리가
 * postgresql/oracle 뿐이라 H2 에선 아무것도 안 함 → validate 실패하므로 끈다). 이 슬라이스만의 인메모리 DB.
 */
@DataJpaTest
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@TestPropertySource(properties = [
    "spring.datasource.url=jdbc:h2:mem:castest;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE",
    "spring.datasource.driver-class-name=org.h2.Driver",
    "spring.datasource.username=sa",
    "spring.datasource.password=",
    "spring.flyway.enabled=false",
    "spring.jpa.hibernate.ddl-auto=create-drop",
])
class ExecutionSuspensionRepositoryTest {

    @Autowired lateinit var repo: ExecutionSuspensionRepository
    @Autowired lateinit var em: TestEntityManager

    private fun persist(execId: UUID, node: String) {
        em.persist(ExecutionSuspension.of(execId, "t1", node, "cipher", "{}", null))
        em.flush(); em.clear()
    }

    @Test
    fun `노드 일치 조건부 삭제는 1행 반환하고 행을 제거한다`() {
        val execId = UUID.randomUUID()
        persist(execId, "w1")
        assertEquals(1, repo.deleteByExecutionIdAndPendingNodeId(execId, "w1"))
        em.clear()
        assertFalse(repo.findById(execId).isPresent)
    }

    @Test
    fun `노드 불일치 삭제는 0행이고 행을 보존한다(PK-only 삭제 회귀 방지)`() {
        val execId = UUID.randomUUID()
        persist(execId, "w1")
        // PK(execution_id)는 같지만 pending_node_id 가 다르다 → 삭제되면 안 된다.
        assertEquals(0, repo.deleteByExecutionIdAndPendingNodeId(execId, "w2"))
        em.clear()
        assertTrue(repo.findById(execId).isPresent, "조건부 DELETE 가 PK 로만 지웠다면 행이 사라진다")
    }

    @Test
    fun `이미 삭제된 뒤 재호출은 멱등하게 0행`() {
        val execId = UUID.randomUUID()
        persist(execId, "w1")
        assertEquals(1, repo.deleteByExecutionIdAndPendingNodeId(execId, "w1"))
        assertEquals(0, repo.deleteByExecutionIdAndPendingNodeId(execId, "w1"))
    }

    @Test
    fun `deleteByExecutionId 는 노드 무관하게 정리한다`() {
        val execId = UUID.randomUUID()
        persist(execId, "someNode")
        assertEquals(1, repo.deleteByExecutionId(execId))
        em.clear()
        assertFalse(repo.findById(execId).isPresent)
    }
}
