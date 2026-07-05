package com.flowlink.core.domain

/** 실행 중 개별 노드의 상태. */
enum class NodeExecutionStatus {
    RUNNING,
    SUCCEEDED,
    FAILED,

    /** wait 노드가 입력 대기 중. */
    WAITING,

    /** 도달하지 않은(분기 미선택) 노드. */
    SKIPPED,
}
