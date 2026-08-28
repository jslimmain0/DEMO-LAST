-- 워크스페이스(폴더 위 최상위 그룹) + 멤버십 롤 + 사용자 레지스트리 (Oracle)
-- 공용은 DB 행 없는 가상 스코프(flow/folder.workspace_id = NULL) — 기존 데이터 전부 공용으로 남는다.
CREATE TABLE workspace (
    id             varchar2(36 char) PRIMARY KEY,
    tenant_id      varchar2(64 char) NOT NULL,
    name           varchar2(120 char) NOT NULL,
    kind           varchar2(16 char) NOT NULL,          -- PERSONAL | TEAM
    owner_username varchar2(120 char),                  -- PERSONAL 의 소유자(TEAM 은 NULL)
    created_at     timestamp with time zone DEFAULT systimestamp NOT NULL
);
CREATE INDEX idx_workspace_tenant ON workspace (tenant_id);

CREATE TABLE workspace_member (
    id           varchar2(36 char) PRIMARY KEY,
    workspace_id varchar2(36 char) NOT NULL,
    username     varchar2(120 char) NOT NULL,
    role         varchar2(16 char) NOT NULL,            -- OWNER | EDITOR | VIEWER
    created_at   timestamp with time zone DEFAULT systimestamp NOT NULL
);
CREATE UNIQUE INDEX idx_wsmember_ws_user ON workspace_member (workspace_id, username);
CREATE INDEX idx_wsmember_user ON workspace_member (username);

CREATE TABLE app_user (
    id           varchar2(36 char) PRIMARY KEY,
    tenant_id    varchar2(64 char) NOT NULL,
    username     varchar2(120 char) NOT NULL,
    global_role  varchar2(16 char) NOT NULL,            -- ADMIN | MEMBER
    last_seen_at timestamp with time zone,
    created_at   timestamp with time zone DEFAULT systimestamp NOT NULL
);
CREATE UNIQUE INDEX idx_appuser_tenant_user ON app_user (tenant_id, username);

ALTER TABLE flow ADD workspace_id varchar2(36 char);
ALTER TABLE folder ADD workspace_id varchar2(36 char);
CREATE INDEX idx_flow_workspace ON flow (workspace_id);
CREATE INDEX idx_folder_workspace ON folder (workspace_id);
