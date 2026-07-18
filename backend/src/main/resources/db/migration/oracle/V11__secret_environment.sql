-- 시크릿 환경 스코프(Oracle). '*' = 공통. ADD ... DEFAULT NOT NULL 은 기존 행을 '*' 로 백필.
ALTER TABLE secret ADD (environment varchar2(120 char) DEFAULT '*' NOT NULL);

DROP INDEX idx_secret_tenant_name;
CREATE UNIQUE INDEX idx_secret_tenant_env_name ON secret (tenant_id, environment, name);
