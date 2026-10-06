package com.flowlink.common.error

import java.time.Instant

/** 표준 에러 응답 바디 (RFC 7807에 준하는 단순화 형태). */
data class ApiError(
    val timestamp: Instant,
    val status: Int,
    val error: String,
    val message: String?,
    val path: String,
    val details: List<String>
) {
    companion object {
        @JvmStatic
        fun of(
            status: Int,
            error: String,
            message: String?,
            path: String,
            details: List<String>?
        ): ApiError =
            ApiError(Instant.now(), status, error, message, path, details ?: emptyList())
    }
}
