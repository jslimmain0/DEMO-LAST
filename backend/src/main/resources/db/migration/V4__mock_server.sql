-- Mock 서버 기능 — 워크플로가 호출할 가짜 대상 시스템을 정의·서빙하는 1급 리소스.
CREATE TABLE mock_server (
    id          uuid         PRIMARY KEY,
    tenant_id   varchar(64)  NOT NULL,
    name        varchar(255) NOT NULL,
    slug        varchar(64)  NOT NULL,
    kind        varchar(16)  NOT NULL,
    enabled     boolean      NOT NULL DEFAULT true,
    spec_json   text,
    created_at  timestamptz  NOT NULL,
    updated_at  timestamptz  NOT NULL
);
-- slug 는 서빙 URL 경로(/mock/{slug})라서 전역 유니크
CREATE UNIQUE INDEX ux_mock_server_slug ON mock_server (slug);
CREATE INDEX idx_mock_server_tenant ON mock_server (tenant_id);
