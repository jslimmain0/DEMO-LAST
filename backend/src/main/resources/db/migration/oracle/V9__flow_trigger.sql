-- 자동 실행 트리거(Oracle) — 스케줄(cron)·인바운드 웹훅.
CREATE TABLE flow_trigger (
    id             varchar2(36 char) PRIMARY KEY,
    tenant_id      varchar2(64 char) NOT NULL,
    flow_id        varchar2(36 char) NOT NULL,
    type           varchar2(16 char) NOT NULL,
    enabled        number(1) DEFAULT 1 NOT NULL,
    cron           varchar2(120 char),
    webhook_token  varchar2(64 char),
    version_no     number(10),
    input_json     clob,
    next_run_at    timestamp with time zone,
    last_run_at    timestamp with time zone,
    created_at     timestamp with time zone DEFAULT systimestamp NOT NULL,
    CONSTRAINT fk_flow_trigger_flow FOREIGN KEY (flow_id) REFERENCES flow(id) ON DELETE CASCADE
);
-- Oracle 단일 컬럼 유니크 인덱스는 다중 NULL 을 허용하므로 webhook 없는(스케줄) 행과 공존한다.
CREATE UNIQUE INDEX idx_flow_trigger_webhook ON flow_trigger (webhook_token);
CREATE INDEX idx_flow_trigger_due ON flow_trigger (type, enabled, next_run_at);
CREATE INDEX idx_flow_trigger_flow ON flow_trigger (flow_id, tenant_id);
