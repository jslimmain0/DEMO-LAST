-- 모든 테이블에 flowlink_ 접두사 — 공유 스키마에서 다른 앱 테이블(flow/execution/secret 등 범용 이름)과 충돌 방지.
-- FK·인덱스·제약은 테이블을 따라간다(이름은 그대로). 신규 DB 도 V1~V19 후 이 스크립트로 같은 최종 상태.
ALTER TABLE app_setting RENAME TO flowlink_app_setting;
ALTER TABLE app_user RENAME TO flowlink_app_user;
ALTER TABLE assistant_session RENAME TO flowlink_assistant_session;
ALTER TABLE environment RENAME TO flowlink_environment;
ALTER TABLE execution RENAME TO flowlink_execution;
ALTER TABLE execution_suspension RENAME TO flowlink_execution_suspension;
ALTER TABLE flow RENAME TO flowlink_flow;
ALTER TABLE flow_trigger RENAME TO flowlink_flow_trigger;
ALTER TABLE flow_version RENAME TO flowlink_flow_version;
ALTER TABLE folder RENAME TO flowlink_folder;
ALTER TABLE mock_server RENAME TO flowlink_mock_server;
ALTER TABLE node_execution RENAME TO flowlink_node_execution;
ALTER TABLE secret RENAME TO flowlink_secret;
ALTER TABLE workspace RENAME TO flowlink_workspace;
ALTER TABLE workspace_member RENAME TO flowlink_workspace_member;
