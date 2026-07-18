package com.flowlink.assistant

/** OAuth provider 설정(조회 — client_secret 은 hasSecret 로만). */
data class OAuthProviderConfig(
    val authorizeUrl: String,
    val tokenUrl: String,
    val clientId: String,
    val scope: String,
    val hasSecret: Boolean,
    val configured: Boolean,
)

/** OAuth provider 설정 저장(admin). clientSecret 이 null/미포함이면 기존 값 유지, 빈 문자열이면 삭제. */
data class OAuthProviderUpdate(
    val authorizeUrl: String? = null,
    val tokenUrl: String? = null,
    val clientId: String? = null,
    val clientSecret: String? = null,
    val scope: String? = null,
)

/** 연결 상태 — 프론트 'AI 연결' 버튼 표시용. */
data class OAuthStatus(
    val providerConfigured: Boolean,
    val connected: Boolean,
    val expiresAt: Long?, // epoch ms, 없으면 null
)

/** authorize 리다이렉트 URL(프론트가 이 주소로 브라우저 이동). */
data class AuthorizeUrlResponse(val url: String)
