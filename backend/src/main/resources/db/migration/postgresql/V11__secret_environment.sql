-- 시크릿 환경(dev/staging/prod) 스코프 — 같은 이름을 환경별로 다르게. '*' = 공통(전역).
-- NOT NULL DEFAULT '*' 로 기존 전역 시크릿(V10)은 자동 백필돼 "공통"이 된다(후방호환).
ALTER TABLE secret ADD COLUMN environment varchar(120) NOT NULL DEFAULT '*';

-- 유니크를 (tenant, name) → (tenant, environment, name) 로 교체.
DROP INDEX idx_secret_tenant_name;
CREATE UNIQUE INDEX idx_secret_tenant_env_name ON secret (tenant_id, environment, name);
