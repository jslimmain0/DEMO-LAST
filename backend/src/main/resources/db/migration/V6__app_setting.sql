-- 앱 설정(키-값) — 콜백 수신 주소(relay base) 등 화면에서 저장하는 런타임 설정.
CREATE TABLE app_setting (
    id            uuid         PRIMARY KEY,
    tenant_id     varchar(64)  NOT NULL,
    setting_key   varchar(128) NOT NULL,
    setting_value text,
    updated_at    timestamptz  NOT NULL,
    CONSTRAINT uq_app_setting UNIQUE (tenant_id, setting_key)
);
