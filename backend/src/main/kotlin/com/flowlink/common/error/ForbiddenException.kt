package com.flowlink.common.error

/** 403 — 인증은 됐지만 권한이 없는 접근(워크스페이스 롤 등). */
class ForbiddenException(message: String) : RuntimeException(message)
