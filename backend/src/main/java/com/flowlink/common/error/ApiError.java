package com.flowlink.common.error;

import java.time.Instant;
import java.util.List;

/** 표준 에러 응답 바디 (RFC 7807에 준하는 단순화 형태). */
public record ApiError(
        Instant timestamp,
        int status,
        String error,
        String message,
        String path,
        List<String> details
) {
    public static ApiError of(int status, String error, String message, String path, List<String> details) {
        return new ApiError(Instant.now(), status, error, message, path, details == null ? List.of() : details);
    }
}
