-- 성능 인덱스 — 실행 이력 목록(테넌트 스코프 + 최신순 정렬)이 매번 풀스캔+정렬하던 것.
-- (flow/folder/mock 의 workspace_id 인덱스는 V13/V15 에서 이미 생성)
CREATE INDEX idx_execution_tenant_started ON execution (tenant_id, started_at);
