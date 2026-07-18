package com.flowlink.assistant

/**
 * GitHub OAuth 설정(조회 — client_secret 은 hasSecret 로만). authorize/token URL 은 GitHub 고정.
 * [gatewayBaseUrl]/[gatewayModel] = GitHub 토큰으로 호출할 AI 게이트웨이(OpenAI 호환, 기본 GitHub Models).
 */
data class OAuthProviderConfig(
    val clientId: String,
    val scope: String,
    val hasSecret: Boolean,
    val configured: Boolean,
    val gatewayBaseUrl: String,
    val gatewayModel: String,
)

/** GitHub OAuth 설정 저장(admin). clientSecret 이 null 이면 기존 값 유지, 빈 문자열이면 삭제. */
data class OAuthProviderUpdate(
    val clientId: String? = null,
    val clientSecret: String? = null,
    val scope: String? = null,
    val gatewayBaseUrl: String? = null,
    val gatewayModel: String? = null,
)

/** 연결 상태 — 프론트 'GitHub 연결' 버튼 표시용. */
data class OAuthStatus(
    val providerConfigured: Boolean,
    val connected: Boolean,
    val expiresAt: Long?, // epoch ms, 없으면 null
)

/** authorize 리다이렉트 URL(프론트가 팝업으로 연다). */
data class AuthorizeUrlResponse(val url: String)
