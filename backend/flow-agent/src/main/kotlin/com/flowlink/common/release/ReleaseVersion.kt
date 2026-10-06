package com.flowlink.common.release

import java.util.Properties

/** VERSION에서 빌드한 값만 사용한다. Gradle의 개발용 project.version과 설치 버전을 혼동하지 않는다. */
object ReleaseVersion {
    val version: String by lazy {
        val properties = Properties()
        ReleaseVersion::class.java.getResourceAsStream("/flowlink-release.properties")?.use(properties::load)
        properties.getProperty("version")?.trim()?.takeIf(::isValid) ?: "unknown"
    }

    private val format = Regex("(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)")

    fun isValid(value: String): Boolean = format.matches(value) && value.split('.').all { it.toIntOrNull() != null }

    fun compare(left: String, right: String): Int {
        require(isValid(left) && isValid(right)) { "버전은 숫자 세 자리 형식이어야 합니다." }
        left.split('.').map(String::toInt).zip(right.split('.').map(String::toInt)).forEach { (a, b) ->
            if (a != b) return a.compareTo(b)
        }
        return 0
    }
}
