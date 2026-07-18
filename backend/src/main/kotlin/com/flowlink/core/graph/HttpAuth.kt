package com.flowlink.core.graph

import com.fasterxml.jackson.annotation.JsonIgnoreProperties

/**
 * HTTP 노드 인증 설정. 현재 OAuth2 client_credentials(M2M) 지원 — 백엔드가 실행 직전 토큰을
 * 취득·캐시해 `Authorization: Bearer` 로 주입한다(server 모드 한정). 값엔 `{{ 이름@secret }}` 토큰 가능.
 *
 * type: null/"none" = 인증 없음, "oauth2_cc" = OAuth2 Client Credentials.
 * clientAuth: "body"(기본, 폼 필드로 전달) | "basic"(Authorization: Basic base64(id:secret)).
 */
@JsonIgnoreProperties(ignoreUnknown = true)
data class HttpAuth(
    val type: String? = null,
    val tokenUrl: String? = null,
    val clientId: String? = null,
    val clientSecret: String? = null,
    val scope: String? = null,
    val clientAuth: String? = null,
    val cacheSeconds: Int? = null,
) {
    fun isOAuthCc(): Boolean = type == "oauth2_cc" && !tokenUrl.isNullOrBlank()
}
