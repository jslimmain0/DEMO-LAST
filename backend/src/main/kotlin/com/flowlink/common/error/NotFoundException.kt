package com.flowlink.common.error

/** 요청한 리소스를 찾지 못했을 때. (HTTP 404로 매핑) */
class NotFoundException(message: String) : RuntimeException(message) {

    companion object {
        @JvmStatic
        fun of(type: String, id: Any?): NotFoundException =
            NotFoundException("$type not found: $id")
    }
}
