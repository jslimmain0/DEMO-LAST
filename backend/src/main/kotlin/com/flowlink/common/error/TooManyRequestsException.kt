package com.flowlink.common.error

/** 서버가 감당할 수 없는 부하(실행 워커 큐 가득참 등) — 429 로 매핑. */
class TooManyRequestsException(message: String) : RuntimeException(message)
