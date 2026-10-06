package com.flowlink.transform

import java.util.UUID

/** 플러그인 조회에 사용할 공간 키. null의 개인/공용 해석과 검증은 호스트가 담당한다. */
interface TransformScope {
    val pluginsEnabled: Boolean get() = true
    fun key(id: UUID? = null): String
}
