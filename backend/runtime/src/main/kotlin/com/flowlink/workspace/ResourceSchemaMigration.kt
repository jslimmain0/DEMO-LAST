package com.flowlink.workspace

import com.flowlink.transform.TransformRegistry
import org.springframework.boot.context.event.ApplicationReadyEvent
import org.springframework.context.event.EventListener
import org.springframework.core.annotation.Order
import org.springframework.stereotype.Component
import javax.sql.DataSource

/** H2의 ddl-auto:update가 제거하지 않는 과거 전역 유니크 제약을 이관한다. Oracle은 db/upgrade-workspace-resources.sql. */
@Component
class ResourceSchemaMigration(private val dataSource: DataSource, private val workspace: WorkspaceService, private val registry: TransformRegistry) {
    @EventListener(ApplicationReadyEvent::class)
    @Order(1)
    fun migrate() {
        dataSource.connection.use { c ->
            if (!c.metaData.databaseProductName.contains("H2", true)) return
            val tables = listOf("flowlink_environment", "flowlink_secret", "flowlink_protocol", "flowlink_plugin_script", "flowlink_mock_server")
            for (table in tables) {
                // 제약명이 Hibernate 버전마다 달라도 컬럼 집합으로 구 전역 유니크만 식별한다.
                val legacy = mutableListOf<String>()
                c.prepareStatement("SELECT CONSTRAINT_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS WHERE UPPER(TABLE_NAME) = ? AND CONSTRAINT_TYPE = 'UNIQUE'").use { q ->
                    q.setString(1, table.uppercase())
                    q.executeQuery().use { rows -> while (rows.next()) {
                        val name = rows.getString(1)
                        val cols = mutableSetOf<String>()
                        c.prepareStatement("SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE CONSTRAINT_NAME = ?").use { colq ->
                            colq.setString(1, name)
                            colq.executeQuery().use { columns -> while (columns.next()) cols.add(columns.getString(1).uppercase()) }
                        }
                        if ("TENANT_ID" in cols && "WORKSPACE_KEY" !in cols && ("NAME" in cols || "SLUG" in cols || "PLUGIN_ID" in cols)) legacy.add(name)
                    } }
                }
                for (name in legacy) c.createStatement().use { it.execute("ALTER TABLE $table DROP CONSTRAINT \"${name.replace("\"", "\"\"")}\"") }
            }
            for (index in listOf("idx_environment_tenant_name", "idx_secret_tenant_env_name", "idx_protocol_tenant_name", "idx_plugin_script_tenant_pid")) {
                c.createStatement().use { it.execute("DROP INDEX IF EXISTS $index") }
            }
            if (workspace.localRuntime) {
                val key = workspace.resolveId(null)!!.toString()
                for (table in tables.dropLast(1)) c.prepareStatement("UPDATE $table SET workspace_key = ? WHERE workspace_key = 'public'").use {
                    it.setString(1, key); it.executeUpdate()
                }
            }
            c.createStatement().use { it.executeUpdate("UPDATE flowlink_mock_server SET workspace_key = COALESCE(workspace_id, 'public')") }
        }
        registry.reload()
    }
}
