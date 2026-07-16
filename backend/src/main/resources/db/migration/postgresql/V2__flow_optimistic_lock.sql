-- 동시 편집 lost-update 방지용 낙관적 잠금 컬럼.
ALTER TABLE flow ADD COLUMN version bigint NOT NULL DEFAULT 0;
