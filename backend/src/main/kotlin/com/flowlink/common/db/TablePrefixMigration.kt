package com.flowlink.common.db

import org.slf4j.LoggerFactory
import org.springframework.boot.autoconfigure.orm.jpa.EntityManagerFactoryDependsOnPostProcessor
import org.springframework.context.annotation.Configuration
import org.springframework.stereotype.Component
import java.sql.Connection
import javax.sql.DataSource

/**
 * local(H2, ddl-auto) 관용 — 접두사 없는 구 테이블(flow/execution/…)이 있으면 **Hibernate 스키마 생성 전에**
 * `flowlink_*` 로 이름을 바꿔 기존 로컬 데이터를 보존한다. (Flyway DB(Oracle)는 V20 마이그레이션이 같은 일을 하므로 실행 안 함.)
 *
 * 규칙(테이블마다):
 *  - 구 테이블만 있음 → RENAME.
 *  - 구·신 둘 다 있음(이전 기동이 빈 flowlink_* 를 먼저 만든 경우) → **데이터가 있는 구 테이블이 이긴다**: 신 테이블을 DROP 하고 RENAME.
 *    (신 테이블의 행은 기동 부트스트랩(dev 사용자·개인 워크스페이스)뿐 — 구 테이블에 같은 행이 있으므로 버려도 무손실. 행 수는 로그에 남긴다.)
 *  - 구 테이블이 비어 있음 → 구 테이블 DROP(신 유지).
 * 순서가 핵심: [Dep] 가 entityManagerFactory 를 이 빈에 의존시켜 ddl-auto 보다 먼저 실행되게 한다(Flyway 자동설정과 같은 장치).
 * 구 테이블의 인덱스는 이름 그대로 따라오므로 Hibernate 의 "index already exists" WARN 은 무해.
 */
@Component("tablePrefixMigration")
class TablePrefixMigration(private val dataSource: DataSource) {

    private val log = LoggerFactory.getLogger(TablePrefixMigration::class.java)

    init {
        run()
    }

    private fun run() {
        try {
            dataSource.connection.use { c ->
                val product = c.metaData.databaseProductName ?: ""
                if (!product.contains("H2", ignoreCase = true)) return
                val existing = tableNames(c)
                var renamed = 0
                for (t in TABLES) {
                    val new = "flowlink_$t"
                    if (t !in existing) continue
                    val oldRows = count(c, t)
                    if (new in existing) {
                        val newRows = count(c, new)
                        if (oldRows == 0L) {
                            exec(c, "DROP TABLE $t CASCADE")
                            log.info("H2 구 테이블 {} 은 비어 있어 삭제(신 테이블 {} 유지, {}행)", t, new, newRows)
                            continue
                        }
                        exec(c, "DROP TABLE $new CASCADE")
                        if (newRows > 0) log.warn("H2 신 테이블 {} 의 {}행(기동 부트스트랩)을 버리고 구 테이블 {}({}행)로 대체", new, newRows, t, oldRows)
                    }
                    exec(c, "ALTER TABLE $t RENAME TO $new")
                    renamed++
                    log.info("H2 테이블 {} → {} ({}행)", t, new, oldRows)
                }
                if (renamed > 0) log.info("H2 테이블 {}개를 flowlink_ 접두사로 이름 변경(기존 로컬 데이터 보존)", renamed)
            }
        } catch (e: Exception) {
            log.error("테이블 접두사 이관 실패 — 기존 데이터가 구 테이블에 남아 있을 수 있습니다: {}", e.message, e)
        }
    }

    private fun tableNames(c: Connection): Set<String> {
        val out = HashSet<String>()
        c.metaData.getTables(null, null, "%", arrayOf("TABLE", "BASE TABLE")).use { rs ->
            while (rs.next()) out.add(rs.getString("TABLE_NAME").lowercase())
        }
        return out
    }

    private fun count(c: Connection, table: String): Long =
        c.createStatement().use { st -> st.executeQuery("SELECT COUNT(*) FROM $table").use { rs -> if (rs.next()) rs.getLong(1) else 0L } }

    private fun exec(c: Connection, sql: String) {
        c.createStatement().use { it.execute(sql) }
    }

    /** Hibernate(entityManagerFactory)가 이 빈 다음에 초기화되도록. */
    @Configuration
    class Dep : EntityManagerFactoryDependsOnPostProcessor("tablePrefixMigration")

    companion object {
        /** 접두사 대상(구 이름) — FK 를 가진 자식(node_execution/flow_version/execution_suspension/flow_trigger)이 부모보다 뒤에 오게. */
        val TABLES = listOf(
            "app_setting", "app_user", "assistant_session", "environment", "secret", "workspace", "workspace_member", "folder",
            "flow", "flow_version", "flow_trigger", "mock_server", "execution", "node_execution", "execution_suspension",
        )
    }
}
