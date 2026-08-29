-- 📌 보존 버전(커밋) — 자동 보존 정책의 버전 정리에서 제외되는 명시적 스냅샷. NULL=false(레거시).
ALTER TABLE flow_version ADD pinned number(1);
