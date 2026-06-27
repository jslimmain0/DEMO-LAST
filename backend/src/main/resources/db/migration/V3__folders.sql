-- 워크플로 그룹핑용 폴더 + flow.folder_id.
CREATE TABLE folder (
    id          uuid         PRIMARY KEY,
    tenant_id   varchar(64)  NOT NULL,
    name        varchar(255) NOT NULL,
    created_at  timestamptz  NOT NULL,
    updated_at  timestamptz  NOT NULL
);
CREATE INDEX idx_folder_tenant ON folder (tenant_id);

ALTER TABLE flow ADD COLUMN folder_id uuid;
CREATE INDEX idx_flow_folder ON flow (folder_id);
