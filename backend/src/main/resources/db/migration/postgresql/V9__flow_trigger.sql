-- 자동 실행 트리거 — 스케줄(cron)·인바운드 웹훅. 실행은 P2 비동기 워커 풀을 재사용.
CREATE TABLE flow_trigger (
    id             uuid PRIMARY KEY,
    tenant_id      varchar(64) NOT NULL,
    flow_id        uuid NOT NULL REFERENCES flow(id) ON DELETE CASCADE,
    type           varchar(16) NOT NULL,
    enabled        boolean NOT NULL DEFAULT true,
    cron           varchar(120),
    webhook_token  varchar(64),
    version_no     integer,
    input_json     text,
    next_run_at    timestamptz,
    last_run_at    timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_flow_trigger_webhook ON flow_trigger (webhook_token) WHERE webhook_token IS NOT NULL;
CREATE INDEX idx_flow_trigger_due ON flow_trigger (type, enabled, next_run_at);
CREATE INDEX idx_flow_trigger_flow ON flow_trigger (flow_id, tenant_id);
