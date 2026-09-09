-- Mock 서버 정의 버전 스냅샷(워크플로 flow_version 의 Mock 판) + 현재 버전 번호.
CREATE TABLE flowlink_mock_server_version (
    id              varchar2(36 char) PRIMARY KEY,
    mock_server_id  varchar2(36 char) NOT NULL REFERENCES flowlink_mock_server (id) ON DELETE CASCADE,
    version_no      number(10)        NOT NULL,
    spec_json       clob              NOT NULL,
    note            clob,
    created_by      varchar2(255 char),
    pinned          number(1),
    created_at      timestamp with time zone DEFAULT systimestamp NOT NULL,
    CONSTRAINT uq_mock_server_version UNIQUE (mock_server_id, version_no)
);
CREATE INDEX idx_mock_server_version_mock ON flowlink_mock_server_version (mock_server_id);
ALTER TABLE flowlink_mock_server ADD current_version number(10);
