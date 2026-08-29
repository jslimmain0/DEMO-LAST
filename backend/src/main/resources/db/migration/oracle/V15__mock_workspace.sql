-- Mock 서버도 워크스페이스 스코프(null=공용) — flow/folder 와 동일 규약.
ALTER TABLE mock_server ADD workspace_id varchar2(36 char);
CREATE INDEX idx_mock_workspace ON mock_server (workspace_id);
