-- Oracle 기존 서버 업그레이드. 앱 중지 + DB 백업 후 한 번 실행한다.
-- 기존 테넌트 공통 자원은 공용 공간으로 유지한다. H2는 ResourceSchemaMigration이 처리한다.
ALTER TABLE flowlink_environment ADD workspace_key varchar2(36 char) DEFAULT 'public' NOT NULL;
ALTER TABLE flowlink_secret ADD workspace_key varchar2(36 char) DEFAULT 'public' NOT NULL;
ALTER TABLE flowlink_protocol ADD workspace_key varchar2(36 char) DEFAULT 'public' NOT NULL;
ALTER TABLE flowlink_plugin_script ADD workspace_key varchar2(36 char) DEFAULT 'public' NOT NULL;
ALTER TABLE flowlink_mock_server ADD workspace_key varchar2(36 char) DEFAULT 'public' NOT NULL;
UPDATE flowlink_mock_server SET workspace_key = COALESCE(workspace_id, 'public');
DROP INDEX idx_environment_tenant_name;
DROP INDEX idx_secret_tenant_env_name;
DROP INDEX idx_protocol_tenant_name;
DROP INDEX idx_plugin_script_tenant_pid;
ALTER TABLE flowlink_mock_server DROP CONSTRAINT uq_mock_server_tenant_slug;
CREATE UNIQUE INDEX idx_environment_scope_name ON flowlink_environment (tenant_id, workspace_key, name);
CREATE UNIQUE INDEX idx_secret_scope_env_name ON flowlink_secret (tenant_id, workspace_key, environment, name);
CREATE UNIQUE INDEX idx_protocol_scope_name ON flowlink_protocol (tenant_id, workspace_key, name);
CREATE UNIQUE INDEX idx_plugin_script_scope_pid ON flowlink_plugin_script (tenant_id, workspace_key, plugin_id);
ALTER TABLE flowlink_mock_server ADD CONSTRAINT uq_mock_server_scope_slug UNIQUE (tenant_id, workspace_key, slug);
COMMIT;
