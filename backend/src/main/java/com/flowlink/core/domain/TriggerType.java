package com.flowlink.core.domain;

/** 실행을 시작시킨 트리거 종류. */
public enum TriggerType {
    /** 사용자가 UI/API로 직접 실행. */
    MANUAL,
    /** cron 스케줄. (후속 Phase) */
    SCHEDULE,
    /** 인바운드 웹훅. (후속 Phase) */
    WEBHOOK,
    /** 이벤트 구독. (후속 Phase) */
    EVENT
}
