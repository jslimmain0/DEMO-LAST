-- Existing Oracle installations: apply once before deploying the hybrid agent runtime.
ALTER TABLE flowlink_execution ADD (agent_device_id VARCHAR2(160), run_request_hash VARCHAR2(64));
ALTER TABLE flowlink_node_execution ADD (execution_agent VARCHAR2(12));
COMMIT;
