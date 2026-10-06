package com.flowlink.workspace

import com.flowlink.transform.TransformRegistry
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.mockito.Mockito
import org.springframework.jdbc.datasource.DriverManagerDataSource

class ResourceSchemaMigrationTest {
    @Test fun `H2 기존 전역 유니크를 제거하고 팀 slug를 보존하며 반복 이관도 안전하다`() {
        val source = DriverManagerDataSource("jdbc:h2:mem:resource-migration;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "")
        source.connection.use { c -> c.createStatement().use { q ->
            for (table in listOf("environment", "secret", "protocol", "plugin_script", "mock_server")) {
                q.execute("CREATE TABLE flowlink_$table (tenant_id varchar(64), workspace_key varchar(36) default 'public', workspace_id varchar(36), name varchar(120), slug varchar(64), plugin_id varchar(64), environment varchar(120))")
            }
            q.execute("ALTER TABLE flowlink_mock_server ADD CONSTRAINT uq_mock_server_tenant_slug UNIQUE(tenant_id, slug)")
            q.execute("CREATE UNIQUE INDEX idx_environment_tenant_name ON flowlink_environment(tenant_id, name)")
            q.execute("CREATE UNIQUE INDEX idx_environment_scope_name ON flowlink_environment(tenant_id, workspace_key, name)")
            q.execute("INSERT INTO flowlink_mock_server(tenant_id, workspace_id, slug) VALUES ('default', '11111111-1111-1111-1111-111111111111', 'same')")
        } }
        val workspace = Mockito.mock(WorkspaceService::class.java)
        val registry = Mockito.mock(TransformRegistry::class.java)
        val migration = ResourceSchemaMigration(source, workspace, registry)
        migration.migrate(); migration.migrate()
        source.connection.use { c -> c.createStatement().use { q ->
            q.executeQuery("SELECT workspace_key FROM flowlink_mock_server").use { rows -> rows.next(); assertThat(rows.getString(1)).isEqualTo("11111111-1111-1111-1111-111111111111") }
            q.execute("INSERT INTO flowlink_mock_server(tenant_id, workspace_id, workspace_key, slug) VALUES ('default', '22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'same')")
            q.execute("INSERT INTO flowlink_environment(tenant_id, workspace_key, name) VALUES ('default', 'public', 'same'), ('default', 'team', 'same')")
            q.executeQuery("SELECT COUNT(*) FROM flowlink_environment").use { rows -> rows.next(); assertThat(rows.getInt(1)).isEqualTo(2) }
        } }
    }
}
