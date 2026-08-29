-- 개인 워크스페이스 유니크 보장 — 동시 첫 로그인(read-then-create)으로 PERSONAL 이 2개 생기면
-- 이후 findBy...Owner 파생 쿼리(Optional)가 영구 500 이 되는 것을 DB 레벨에서 차단.
CREATE UNIQUE INDEX idx_ws_personal_owner ON workspace (
    CASE WHEN kind = 'PERSONAL' THEN tenant_id END,
    CASE WHEN kind = 'PERSONAL' THEN owner_username END
);
