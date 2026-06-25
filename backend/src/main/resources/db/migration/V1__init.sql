-- Flowlink 초기 스키마 (Flyway). 스키마 소유권은 Flyway, JPA 는 validate 만 수행.
-- 정의 그래프/입출력은 Phase 1 에서 text(원시 JSON 문자열)로 보관해 무손실 라운드트립을 보장한다.
-- (Phase 2: jsonb + 전용 타입핸들러로 전환해 경로 질의/GIN 인덱스 확보)

CREATE TABLE flow (
    id              uuid         PRIMARY KEY,
    tenant_id       varchar(64)  NOT NULL,
    name            varchar(255) NOT NULL,
    description     text,
    current_version integer      NOT NULL DEFAULT 0,
    archived        boolean      NOT NULL DEFAULT false,
    created_at      timestamptz  NOT NULL,
    updated_at      timestamptz  NOT NULL
);
CREATE INDEX idx_flow_tenant ON flow (tenant_id, archived);

CREATE TABLE flow_version (
    id          uuid         PRIMARY KEY,
    flow_id     uuid         NOT NULL REFERENCES flow (id) ON DELETE CASCADE,
    version_no  integer      NOT NULL,
    name        varchar(255) NOT NULL,
    graph_json  text         NOT NULL,
    note        text,
    created_by  varchar(255),
    created_at  timestamptz  NOT NULL,
    CONSTRAINT uq_flow_version UNIQUE (flow_id, version_no)
);
CREATE INDEX idx_flow_version_flow ON flow_version (flow_id);

CREATE TABLE execution (
    id              uuid         PRIMARY KEY,
    tenant_id       varchar(64)  NOT NULL,
    flow_id         uuid         NOT NULL,
    flow_version_id uuid         NOT NULL,
    status          varchar(20)  NOT NULL,
    trigger_type    varchar(20)  NOT NULL,
    triggered_by    varchar(255),
    input_json      text,
    started_at      timestamptz,
    finished_at     timestamptz,
    error           text,
    created_at      timestamptz  NOT NULL
);
CREATE INDEX idx_execution_tenant   ON execution (tenant_id, started_at DESC);
CREATE INDEX idx_execution_flow     ON execution (flow_id, started_at DESC);

CREATE TABLE node_execution (
    id            uuid         PRIMARY KEY,
    execution_id  uuid         NOT NULL REFERENCES execution (id) ON DELETE CASCADE,
    node_id       varchar(64)  NOT NULL,
    node_name     varchar(255),
    node_type     varchar(20),
    seq           integer      NOT NULL,
    status        varchar(20)  NOT NULL,
    http_status   integer,
    duration_ms   bigint,
    ok            boolean      NOT NULL DEFAULT false,
    request_text  text,
    response_text text,
    output_json   text,
    started_at    timestamptz,
    finished_at   timestamptz
);
CREATE INDEX idx_node_exec_execution ON node_execution (execution_id, seq);
