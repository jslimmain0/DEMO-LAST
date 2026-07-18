-- AI 어시스턴트 대화 세션(Oracle) — 사용자별 저장. messages 는 대화 턴 JSON 원문(clob).
CREATE TABLE assistant_session (
    id          varchar2(36 char) PRIMARY KEY,
    tenant_id   varchar2(64 char) NOT NULL,
    username    varchar2(180 char) NOT NULL,
    title       varchar2(300 char) NOT NULL,
    messages    clob NOT NULL,
    created_at  timestamp with time zone DEFAULT systimestamp NOT NULL,
    updated_at  timestamp with time zone DEFAULT systimestamp NOT NULL
);
CREATE INDEX idx_assistant_session_owner ON assistant_session (tenant_id, username, updated_at DESC);
