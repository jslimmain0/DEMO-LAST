-- FlowLink Oracle 풀스키마 — postgresql/V1~V8 의 최종 상태를 통합(신규 Oracle DB 전용).
-- uuid=varchar2(36)+preferred_uuid_jdbc_type CHAR, text=clob, boolean=number(1), timestamptz=timestamp with time zone.
-- varchar 는 문자 단위(char) — 한글 이름/메시지 바이트 잘림 방지.

CREATE TABLE flow (
    id              varchar2(36)       PRIMARY KEY,
    tenant_id       varchar2(64 char)  NOT NULL,
    name            varchar2(255 char) NOT NULL,
    description     clob,
    current_version number(10)         DEFAULT 0 NOT NULL,
    archived        number(1)          DEFAULT 0 NOT NULL,
    version         number(19)         DEFAULT 0 NOT NULL,
    folder_id       varchar2(36),
    created_at      timestamp with time zone NOT NULL,
    updated_at      timestamp with time zone NOT NULL
);
CREATE INDEX idx_flow_tenant ON flow (tenant_id, archived);
CREATE INDEX idx_flow_folder ON flow (folder_id);

CREATE TABLE flow_version (
    id          varchar2(36)       PRIMARY KEY,
    flow_id     varchar2(36)       NOT NULL REFERENCES flow (id) ON DELETE CASCADE,
    version_no  number(10)         NOT NULL,
    name        varchar2(255 char) NOT NULL,
    graph_json  clob               NOT NULL,
    note        clob,
    created_by  varchar2(255 char),
    created_at  timestamp with time zone NOT NULL,
    CONSTRAINT uq_flow_version UNIQUE (flow_id, version_no)
);
CREATE INDEX idx_flow_version_flow ON flow_version (flow_id);

CREATE TABLE execution (
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
CREATE INDEX idx_execution_tenant ON execution (tenant_id, started_at DESC);
CREATE INDEX idx_execution_flow   ON execution (flow_id, started_at DESC);

CREATE TABLE node_execution (
    id            varchar2(36)       PRIMARY KEY,
    execution_id  varchar2(36)       NOT NULL REFERENCES execution (id) ON DELETE CASCADE,
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
CREATE INDEX idx_node_exec_execution ON node_execution (execution_id, seq);

CREATE TABLE folder (
    id          varchar2(36)       PRIMARY KEY,
    tenant_id   varchar2(64 char)  NOT NULL,
    name        varchar2(255 char) NOT NULL,
    parent_id   varchar2(36),
    created_at  timestamp with time zone NOT NULL,
    updated_at  timestamp with time zone NOT NULL
);
CREATE INDEX idx_folder_tenant ON folder (tenant_id);
CREATE INDEX idx_folder_parent ON folder (parent_id);

CREATE TABLE mock_server (
    id          varchar2(36)       PRIMARY KEY,
    tenant_id   varchar2(64 char)  NOT NULL,
    name        varchar2(255 char) NOT NULL,
    slug        varchar2(64)       NOT NULL,
    kind        varchar2(16)       NOT NULL,
    enabled     number(1)          DEFAULT 1 NOT NULL,
    spec_json   clob,
    created_at  timestamp with time zone NOT NULL,
    updated_at  timestamp with time zone NOT NULL,
    CONSTRAINT uq_mock_server_tenant_slug UNIQUE (tenant_id, slug)
);
CREATE INDEX idx_mock_server_tenant ON mock_server (tenant_id);

CREATE TABLE app_setting (
    id            varchar2(36)       PRIMARY KEY,
    tenant_id     varchar2(64 char)  NOT NULL,
    setting_key   varchar2(128)      NOT NULL,
    setting_value clob,
    updated_at    timestamp with time zone NOT NULL,
    CONSTRAINT uq_app_setting UNIQUE (tenant_id, setting_key)
);

CREATE TABLE execution_suspension (
    execution_id     varchar2(36) PRIMARY KEY REFERENCES execution (id) ON DELETE CASCADE,
    tenant_id        varchar2(64 char) NOT NULL,
    pending_node_id  varchar2(80 char) NOT NULL,   -- char 단위 — 한글 노드 id 도 잘리지 않게
    run_state        clob              NOT NULL,
    outcome_json     clob,
    wait_deadline    timestamp with time zone,
    updated_at       timestamp with time zone DEFAULT systimestamp NOT NULL
);
CREATE INDEX idx_suspension_deadline ON execution_suspension (wait_deadline);
