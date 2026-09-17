package com.flowlink.plugin.script

/** 스크립트 컴파일/실행 오류 — line/col 은 알 수 있을 때만(편집기 거터 표시용). */
class ScriptError(val line: Int?, val col: Int?, message: String, cause: Throwable? = null) : RuntimeException(message, cause)
