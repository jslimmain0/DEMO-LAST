package com.flowlink.assistant

import org.springframework.boot.context.properties.ConfigurationProperties

/**
 * AI 어시스턴트(자연어 → 플로우) 설정. `@ConfigurationPropertiesScan` 이 자동 등록한다.
 *
 * 자격은 사용자별 GitHub 로그인(Copilot 연결, AssistantOAuthService). 연결이 없으면 **stub 모드**(결정적 샘플 그래프)로 동작한다.
 */
@ConfigurationProperties(prefix = "flowlink.assistant")
class AssistantProperties(
    maxTokens: Int? = null,
    maxConcurrent: Int? = null,
) {
    // 대형 플로우(20~30+ 노드) 그래프 JSON 이 잘리지 않게 넉넉히. 4096→22노드 빠듯, 8192→verbose 24노드에서 잘림 관측 → 16384.
    val maxTokens: Int = if (maxTokens == null || maxTokens <= 0) 16384 else maxTokens
    /** 동시 LLM 호출 상한(벌크헤드) — 초과 시 429. 요청 스레드가 느린 업스트림에 고갈되지 않게. */
    val maxConcurrent: Int = if (maxConcurrent == null || maxConcurrent <= 0) 4 else maxConcurrent
}
