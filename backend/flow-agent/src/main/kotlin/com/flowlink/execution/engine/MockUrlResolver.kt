package com.flowlink.execution.engine

import java.util.UUID

/** 바인딩을 해석한 최종 URL의 기존 Mock 경로를 실행 공간에 맞춰 보정한다. */
fun interface MockUrlResolver {
    fun normalize(url: String, workspaceId: UUID?): String
}
