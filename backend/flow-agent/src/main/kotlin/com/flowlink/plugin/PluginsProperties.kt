package com.flowlink.plugin

import org.springframework.boot.context.properties.ConfigurationProperties

/**
 * flowlink.plugins.* — 플러그인 적재 설정. `@ConfigurationPropertiesScan` 이 자동 등록한다.
 *
 * @property dir JAR 드롭 디렉터리(실행 CWD 상대, 기본 plugins). jar-enabled 일 때만 스캔.
 * @property jarEnabled JAR 플러그인 로드 스위치 — **기본 false**(전권 바이너리 예외 경로). env `FLOWLINK_PLUGINS_JAR_ENABLED=true`.
 * @property script 스크립트(JS) 플러그인 샌드박스 상한.
 */
@ConfigurationProperties(prefix = "flowlink.plugins")
class PluginsProperties(
    dir: String? = null,
    jarEnabled: Boolean? = null,
    script: Script? = null,
) {
    val dir: String = dir?.takeIf { it.isNotBlank() } ?: "plugins"
    val jarEnabled: Boolean = jarEnabled ?: false
    val script: Script = script ?: Script()

    /** 호출당 CPU 시간(ms)·문장 수 상한 — 초과 시 그 호출만 실패(스레드 보호). */
    class Script(timeoutMs: Long? = null, statementLimit: Long? = null) {
        val timeoutMs: Long = if (timeoutMs == null || timeoutMs <= 0) 2000 else timeoutMs
        val statementLimit: Long = if (statementLimit == null || statementLimit <= 0) 2_000_000 else statementLimit
    }
}
