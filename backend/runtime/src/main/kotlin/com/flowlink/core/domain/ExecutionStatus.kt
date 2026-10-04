package com.flowlink.core.domain

/** 워크플로 1회 실행(run)의 상태. */
enum class ExecutionStatus {
    /** 큐 대기/시작 전. */
    PENDING,

    /** 실행 중. */
    RUNNING,

    /** wait 노드 등에서 외부 입력/이벤트 대기 중(내구성 실행 진입점). */
    WAITING,

    /** 모든 도달 노드 성공 완료. */
    SUCCEEDED,

    /** 노드 실패로 중단. */
    FAILED,

    /** 사용자가 취소. */
    CANCELLED,
}
