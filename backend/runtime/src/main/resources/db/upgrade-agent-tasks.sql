-- Oracle: 서버 중지와 DB 백업 후 한 번 실행한다. H2는 ddl-auto=update로 적용된다.
CREATE TABLE flowlink_agent_task (
    id varchar2(36 char) PRIMARY KEY,
    execution_id varchar2(36 char) NOT NULL,
    tenant_id varchar2(255 char) NOT NULL,
    username varchar2(255 char) NOT NULL,
    workspace_id varchar2(36 char),
    node_id varchar2(255 char) NOT NULL,
    node_name varchar2(255 char),
    agent varchar2(12 char) NOT NULL,
    device_id varchar2(255 char) NOT NULL,
    status varchar2(16 char) NOT NULL,
    delegation number(1) DEFAULT 0 NOT NULL,
    claim_token varchar2(100 char),
    request_data clob,
    result_data clob,
    duration_ms number(19) DEFAULT 0 NOT NULL,
    error clob,
    updated_at timestamp with time zone DEFAULT systimestamp NOT NULL
);
CREATE INDEX idx_agent_task_exec ON flowlink_agent_task(execution_id);
CREATE INDEX idx_agent_task_status ON flowlink_agent_task(status);
CREATE TABLE flowlink_wait_callback (
    id varchar2(36 char) PRIMARY KEY,
    execution_id varchar2(36 char) NOT NULL,
    node_id varchar2(255 char) NOT NULL,
    payload clob,
    received_at timestamp with time zone DEFAULT systimestamp NOT NULL
);
CREATE INDEX idx_wait_callback_exec ON flowlink_wait_callback(execution_id);
COMMIT;
