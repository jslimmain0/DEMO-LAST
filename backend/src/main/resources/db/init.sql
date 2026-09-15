-- FlowLink Oracle 스키마 (한 파일 — 신규 DB 에 이 스크립트를 한 번 실행한다. 앱은 스키마를 만들거나 검증하지 않는다: dev 프로파일 ddl-auto none).
--   sqlplus flowlink/flowlink@//host:1521/FREEPDB1 @init.sql
-- 규약: uuid=varchar2(36)+preferred_uuid_jdbc_type CHAR · text=clob · boolean=number(1) · timestamptz=timestamp with time zone ·
--       varchar 는 문자 단위(char) — 한글 이름/메시지 바이트 잘림 방지 · 모든 테이블은 flowlink_ 접두사(공유 스키마 충돌 방지).
-- local 프로파일(H2 파일)은 이 파일을 쓰지 않는다(Hibernate ddl-auto update 가 엔티티에서 생성).

-- ---------- 워크스페이스 · 사용자 ----------
CREATE TABLE flowlink_workspace (
    id             varchar2(36 char) PRIMARY KEY,
    tenant_id      varchar2(64 char) NOT NULL,
    name           varchar2(120 char) NOT NULL,
    kind           varchar2(16 char) NOT NULL,          -- PERSONAL | TEAM
    owner_username varchar2(120 char),                  -- PERSONAL 의 소유자(TEAM 은 NULL)
    created_at     timestamp with time zone DEFAULT systimestamp NOT NULL
);
CREATE INDEX idx_workspace_tenant ON flowlink_workspace (tenant_id);
-- 개인 워크스페이스는 (tenant, owner) 당 하나 — 동시 첫 로그인으로 둘이 생기면 파생 쿼리(Optional)가 영구 500.
CREATE UNIQUE INDEX idx_ws_personal_owner ON flowlink_workspace (
    CASE WHEN kind = 'PERSONAL' THEN tenant_id END,
    CASE WHEN kind = 'PERSONAL' THEN owner_username END
);

CREATE TABLE flowlink_workspace_member (
    id           varchar2(36 char) PRIMARY KEY,
    workspace_id varchar2(36 char) NOT NULL,
    username     varchar2(120 char) NOT NULL,
    role         varchar2(16 char) NOT NULL,            -- OWNER | EDITOR | VIEWER
    created_at   timestamp with time zone DEFAULT systimestamp NOT NULL
);
CREATE UNIQUE INDEX idx_wsmember_ws_user ON flowlink_workspace_member (workspace_id, username);
CREATE INDEX idx_wsmember_user ON flowlink_workspace_member (username);

CREATE TABLE flowlink_app_user (
    id           varchar2(36 char) PRIMARY KEY,
    tenant_id    varchar2(64 char) NOT NULL,
    username     varchar2(120 char) NOT NULL,
    global_role  varchar2(16 char) NOT NULL,            -- ADMIN | MEMBER
    status       varchar2(16 char),                     -- PENDING | APPROVED | BLOCKED (NULL=레거시 승인 간주)
    last_seen_at timestamp with time zone,
    created_at   timestamp with time zone DEFAULT systimestamp NOT NULL
);
CREATE UNIQUE INDEX idx_appuser_tenant_user ON flowlink_app_user (tenant_id, username);

-- ---------- 워크플로 ----------
CREATE TABLE flowlink_folder (
    id           varchar2(36)       PRIMARY KEY,
    tenant_id    varchar2(64 char)  NOT NULL,
    name         varchar2(255 char) NOT NULL,
    parent_id    varchar2(36),
    workspace_id varchar2(36 char),                     -- NULL=공용
    created_at   timestamp with time zone NOT NULL,
    updated_at   timestamp with time zone NOT NULL
);
CREATE INDEX idx_folder_tenant ON flowlink_folder (tenant_id);
CREATE INDEX idx_folder_parent ON flowlink_folder (parent_id);
CREATE INDEX idx_folder_workspace ON flowlink_folder (workspace_id);

CREATE TABLE flowlink_flow (
    id              varchar2(36)       PRIMARY KEY,
    tenant_id       varchar2(64 char)  NOT NULL,
    name            varchar2(255 char) NOT NULL,
    description     clob,
    current_version number(10)         DEFAULT 0 NOT NULL,
    archived        number(1)          DEFAULT 0 NOT NULL,
    version         number(19)         DEFAULT 0 NOT NULL,   -- 낙관적 락
    folder_id       varchar2(36),
    workspace_id    varchar2(36 char),                       -- NULL=공용
    created_at      timestamp with time zone NOT NULL,
    updated_at      timestamp with time zone NOT NULL
);
CREATE INDEX idx_flow_tenant ON flowlink_flow (tenant_id, archived);
CREATE INDEX idx_flow_folder ON flowlink_flow (folder_id);
CREATE INDEX idx_flow_workspace ON flowlink_flow (workspace_id);

CREATE TABLE flowlink_flow_version (
    id          varchar2(36)       PRIMARY KEY,
    flow_id     varchar2(36)       NOT NULL REFERENCES flowlink_flow (id) ON DELETE CASCADE,
    version_no  number(10)         NOT NULL,
    name        varchar2(255 char) NOT NULL,
    graph_json  clob               NOT NULL,
    note        clob,
    created_by  varchar2(255 char),
    pinned      number(1),                              -- 📌 보존 버전(자동 정리 제외), NULL=false
    created_at  timestamp with time zone NOT NULL,
    CONSTRAINT uq_flow_version UNIQUE (flow_id, version_no)
);
CREATE INDEX idx_flow_version_flow ON flowlink_flow_version (flow_id);

CREATE TABLE flowlink_flow_trigger (
    id             varchar2(36 char) PRIMARY KEY,
    tenant_id      varchar2(64 char) NOT NULL,
    flow_id        varchar2(36 char) NOT NULL,
    type           varchar2(16 char) NOT NULL,            -- SCHEDULE | WEBHOOK
    enabled        number(1) DEFAULT 1 NOT NULL,
    cron           varchar2(120 char),
    webhook_token  varchar2(64 char),
    version_no     number(10),
    input_json     clob,
    next_run_at    timestamp with time zone,
    last_run_at    timestamp with time zone,
    created_at     timestamp with time zone DEFAULT systimestamp NOT NULL,
    CONSTRAINT fk_flow_trigger_flow FOREIGN KEY (flow_id) REFERENCES flowlink_flow (id) ON DELETE CASCADE
);
-- Oracle 단일 컬럼 유니크 인덱스는 다중 NULL 을 허용 — webhook 없는(스케줄) 행과 공존.
CREATE UNIQUE INDEX idx_flow_trigger_webhook ON flowlink_flow_trigger (webhook_token);
CREATE INDEX idx_flow_trigger_due ON flowlink_flow_trigger (type, enabled, next_run_at);
CREATE INDEX idx_flow_trigger_flow ON flowlink_flow_trigger (flow_id, tenant_id);

-- ---------- 실행 ----------
CREATE TABLE flowlink_execution (
    id              varchar2(36)       PRIMARY KEY,
    tenant_id       varchar2(64 char)  NOT NULL,
    flow_id         varchar2(36)       NOT NULL,
    flow_version_id varchar2(36)       NOT NULL,
    status          varchar2(20)       NOT NULL,
    trigger_type    varchar2(20)       NOT NULL,
    triggered_by    varchar2(255 char),
    input_json      clob,
    started_at      timestamp with time zone,
    finished_at     timestamp with time zone,
    error           clob,
    created_at      timestamp with time zone NOT NULL
);
CREATE INDEX idx_execution_tenant ON flowlink_execution (tenant_id, started_at DESC);
CREATE INDEX idx_execution_flow   ON flowlink_execution (flow_id, started_at DESC);
CREATE INDEX idx_execution_tenant_started ON flowlink_execution (tenant_id, started_at);

CREATE TABLE flowlink_node_execution (
    id            varchar2(36)       PRIMARY KEY,
    execution_id  varchar2(36)       NOT NULL REFERENCES flowlink_execution (id) ON DELETE CASCADE,
    node_id       varchar2(64 char)  NOT NULL,
    node_name     varchar2(255 char),
    node_type     varchar2(20),
    seq           number(10)         NOT NULL,
    status        varchar2(20)       NOT NULL,
    http_status   number(10),
    duration_ms   number(19),
    ok            number(1)          DEFAULT 0 NOT NULL,
    request_text  clob,
    response_text clob,
    output_json   clob,
    started_at    timestamp with time zone,
    finished_at   timestamp with time zone
);
CREATE INDEX idx_node_exec_execution ON flowlink_node_execution (execution_id, seq);

-- 재개 상태(wait/input/form/client 중단 지점) — run_state 는 암호문.
CREATE TABLE flowlink_execution_suspension (
    execution_id     varchar2(36) PRIMARY KEY REFERENCES flowlink_execution (id) ON DELETE CASCADE,
    tenant_id        varchar2(64 char) NOT NULL,
    pending_node_id  varchar2(80 char) NOT NULL,   -- char 단위 — 한글 노드 id 도 잘리지 않게
    run_state        clob              NOT NULL,
    outcome_json     clob,
    wait_deadline    timestamp with time zone,
    updated_at       timestamp with time zone DEFAULT systimestamp NOT NULL
);
CREATE INDEX idx_suspension_deadline ON flowlink_execution_suspension (wait_deadline);

-- ---------- Mock 서버 · 프로토콜 ----------
CREATE TABLE flowlink_mock_server (
    id              varchar2(36)       PRIMARY KEY,
    tenant_id       varchar2(64 char)  NOT NULL,
    name            varchar2(255 char) NOT NULL,
    slug            varchar2(64)       NOT NULL,
    kind            varchar2(16)       NOT NULL,          -- HTTP | TCP (CUSTOM=레거시)
    enabled         number(1)          DEFAULT 1 NOT NULL,
    spec_json       clob,
    workspace_id    varchar2(36 char),                    -- NULL=공용
    current_version number(10),
    created_at      timestamp with time zone NOT NULL,
    updated_at      timestamp with time zone NOT NULL,
    CONSTRAINT uq_mock_server_tenant_slug UNIQUE (tenant_id, slug)
);
CREATE INDEX idx_mock_server_tenant ON flowlink_mock_server (tenant_id);
CREATE INDEX idx_mock_workspace ON flowlink_mock_server (workspace_id);

CREATE TABLE flowlink_mock_server_version (
    id              varchar2(36 char) PRIMARY KEY,
    mock_server_id  varchar2(36 char) NOT NULL REFERENCES flowlink_mock_server (id) ON DELETE CASCADE,
    version_no      number(10)        NOT NULL,
    spec_json       clob              NOT NULL,
    note            clob,
    created_by      varchar2(255 char),
    pinned          number(1),
    created_at      timestamp with time zone DEFAULT systimestamp NOT NULL,
    CONSTRAINT uq_mock_server_version UNIQUE (mock_server_id, version_no)
);
CREATE INDEX idx_mock_server_version_mock ON flowlink_mock_server_version (mock_server_id);

-- 고정길이 전문 프로토콜(필드 스키마) — TCP 노드·TCP Mock·프록시가 공유. 테넌트 스코프, 이름 유니크.
CREATE TABLE flowlink_protocol (
    id          varchar2(36 char) PRIMARY KEY,
    tenant_id   varchar2(64 char) NOT NULL,
    name        varchar2(120 char) NOT NULL,
    spec_json   clob NOT NULL,
    created_at  timestamp with time zone DEFAULT systimestamp NOT NULL,
    updated_at  timestamp with time zone
);
CREATE UNIQUE INDEX idx_protocol_tenant_name ON flowlink_protocol (tenant_id, name);

-- ---------- 설정 · 시크릿 · 환경 · 어시스턴트 ----------
CREATE TABLE flowlink_app_setting (
    id            varchar2(36)       PRIMARY KEY,
    tenant_id     varchar2(64 char)  NOT NULL,
    setting_key   varchar2(128)      NOT NULL,
    setting_value clob,
    updated_at    timestamp with time zone NOT NULL,
    CONSTRAINT uq_app_setting UNIQUE (tenant_id, setting_key)
);

-- 시크릿 볼트 — 값은 암호문(enc_value). environment '*' = 공통, 그 외 = 환경 오버레이.
CREATE TABLE flowlink_secret (
    id          varchar2(36 char) PRIMARY KEY,
    tenant_id   varchar2(64 char) NOT NULL,
    name        varchar2(120 char) NOT NULL,
    environment varchar2(120 char) DEFAULT '*' NOT NULL,
    enc_value   clob NOT NULL,
    created_at  timestamp with time zone DEFAULT systimestamp NOT NULL
);
CREATE UNIQUE INDEX idx_secret_tenant_env_name ON flowlink_secret (tenant_id, environment, name);

CREATE TABLE flowlink_environment (
    id          varchar2(36 char) PRIMARY KEY,
    tenant_id   varchar2(64 char) NOT NULL,
    name        varchar2(120 char) NOT NULL,
    vars_json   clob NOT NULL,
    created_at  timestamp with time zone DEFAULT systimestamp NOT NULL,
    updated_at  timestamp with time zone
);
CREATE UNIQUE INDEX idx_environment_tenant_name ON flowlink_environment (tenant_id, name);

CREATE TABLE flowlink_assistant_session (
    id          varchar2(36 char) PRIMARY KEY,
    tenant_id   varchar2(64 char) NOT NULL,
    username    varchar2(180 char) NOT NULL,
    title       varchar2(300 char) NOT NULL,
    messages    clob NOT NULL,
    created_at  timestamp with time zone DEFAULT systimestamp NOT NULL,
    updated_at  timestamp with time zone DEFAULT systimestamp NOT NULL
);
CREATE INDEX idx_assistant_session_owner ON flowlink_assistant_session (tenant_id, username, updated_at DESC);
