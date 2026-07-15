-- 내구 실행: 중단(WAITING) 상태 영속 — 서버 재시작에도 wait/client/form/input 실행 생존.
-- run_state = RunStateSnapshot JSON 의 AES-GCM 암호문(base64), outcome_json = pending 명세.
CREATE TABLE execution_suspension (
    execution_id     uuid PRIMARY KEY REFERENCES execution(id) ON DELETE CASCADE,
    tenant_id        varchar(64) NOT NULL,
    pending_node_id  varchar(80) NOT NULL,
    run_state        text NOT NULL,
    outcome_json     text,
    wait_deadline    timestamptz,
    updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_suspension_deadline ON execution_suspension (wait_deadline);
