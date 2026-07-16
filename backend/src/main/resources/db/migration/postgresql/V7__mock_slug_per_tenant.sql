-- mock slug 를 전역 유니크 → 팀(테넌트) 스코프 유니크로 전환.
-- 서빙 경로가 /mock/{tenant}/{slug}/** 를 지원하므로 팀끼리 같은 slug 를 써도 충돌하지 않는다.
-- (레거시 /mock/{slug}/** 는 default 테넌트로 폴백 — MockPathResolver)
DROP INDEX IF EXISTS ux_mock_server_slug;
ALTER TABLE mock_server ADD CONSTRAINT uq_mock_server_tenant_slug UNIQUE (tenant_id, slug);
