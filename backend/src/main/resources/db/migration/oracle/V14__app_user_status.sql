-- 가입 신청/승인 모델 — GitHub 로그인 = 가입 신청(PENDING), 관리자가 승인(APPROVED)/차단(BLOCKED).
-- 기존 행은 NULL 유지 = 승인 간주(레거시 — 수동 관리되던 사용자 무회귀).
ALTER TABLE app_user ADD status varchar2(16 char);
