-- backend/src/main/resources/db/migration/oracle/V22__protocol.sql
-- 고정길이 전문 프로토콜(필드 스키마) — TCP 노드·TCP Mock·프록시가 공유. 테넌트 스코프, 이름 유니크.
CREATE TABLE flowlink_protocol (
    id          varchar2(36 char) PRIMARY KEY,
    tenant_id   varchar2(64 char) NOT NULL,
    name        varchar2(120 char) NOT NULL,
    spec_json   clob NOT NULL,
    created_at  timestamp with time zone DEFAULT systimestamp NOT NULL,
    updated_at  timestamp with time zone
);
CREATE UNIQUE INDEX idx_protocol_tenant_name ON flowlink_protocol (tenant_id, name);
