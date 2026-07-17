-- 시크릿 볼트(Oracle) — 값은 AES-GCM 암호문(enc_value).
CREATE TABLE secret (
    id          varchar2(36 char) PRIMARY KEY,
    tenant_id   varchar2(64 char) NOT NULL,
    name        varchar2(120 char) NOT NULL,
    enc_value   clob NOT NULL,
    created_at  timestamp with time zone DEFAULT systimestamp NOT NULL
);
CREATE UNIQUE INDEX idx_secret_tenant_name ON secret (tenant_id, name);
