-- AI 어시스턴트 대화 세션 — 사용자별(tenant + username) 저장. messages 는 대화 턴 JSON 원문.
CREATE TABLE assistant_session (
    id          uuid PRIMARY KEY,
    tenant_id   varchar(64) NOT NULL,
    username    varchar(180) NOT NULL,
    title       varchar(300) NOT NULL,
    messages    text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_assistant_session_owner ON assistant_session (tenant_id, username, updated_at DESC);
