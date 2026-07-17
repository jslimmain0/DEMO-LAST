-- 시크릿 볼트 — 값은 AES-GCM 암호문(enc_value). API write-only, 실행 시 {{ 이름@secret }} 로만 사용.
CREATE TABLE secret (
    id          uuid PRIMARY KEY,
    tenant_id   varchar(64) NOT NULL,
    name        varchar(120) NOT NULL,
    enc_value   text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_secret_tenant_name ON secret (tenant_id, name);
