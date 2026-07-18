package com.flowlink.assistant

import org.springframework.boot.context.properties.ConfigurationProperties

/**
 * AI 어시스턴트(자연어 → 플로우) 설정. `@ConfigurationPropertiesScan` 이 자동 등록한다.
 *
 * 키 해석 우선순위: env/yml [apiKey] → (없으면) 시크릿 볼트의 `anthropic-api-key`.
 * 어느 쪽도 없으면 **stub 모드**(결정적 샘플 그래프)로 동작해 키 없이도 기능이 완결된다.
 */
@ConfigurationProperties(prefix = "flowlink.assistant")
class AssistantProperties(
    apiKey: String? = null,
    model: String? = null,
    baseUrl: String? = null,
    maxTokens: Int? = null,
) {
    val apiKey: String? = if (apiKey.isNullOrBlank()) null else apiKey.trim()
    val model: String = if (model.isNullOrBlank()) "claude-sonnet-5" else model.trim()
    val baseUrl: String = if (baseUrl.isNullOrBlank()) "https://api.anthropic.com" else baseUrl.trim().trimEnd('/')
    val maxTokens: Int = if (maxTokens == null || maxTokens <= 0) 4096 else maxTokens
}
