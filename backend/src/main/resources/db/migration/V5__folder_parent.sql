-- 폴더 중첩(트리) — parent_id (null = 루트). 이중·삼중 등 깊이 제한 없음.
ALTER TABLE folder ADD COLUMN parent_id uuid;
CREATE INDEX idx_folder_parent ON folder (parent_id);
