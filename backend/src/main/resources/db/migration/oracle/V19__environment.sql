-- 실행 환경(dev/staging/prod)+변수 — 브라우저 localStorage 에서 DB(테넌트 스코프, 팀 공유)로.
CREATE TABLE environment (
    id          varchar2(36 char) PRIMARY KEY,
    tenant_id   varchar2(64 char) NOT NULL,
    name        varchar2(120 char) NOT NULL,
    vars_json   clob NOT NULL,
    created_at  timestamp with time zone DEFAULT systimestamp NOT NULL,
    updated_at  timestamp with time zone
);
CREATE UNIQUE INDEX idx_environment_tenant_name ON environment (tenant_id, name);
