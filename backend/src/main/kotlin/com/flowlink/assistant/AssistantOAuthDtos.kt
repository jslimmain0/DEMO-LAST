package com.flowlink.assistant

/** 디바이스 플로우 시작 결과 — 사용자가 verificationUri 에서 userCode 를 입력해 인증한다(Copilot 확장과 동일). */
data class DeviceStart(
    val userCode: String,
    val verificationUri: String,
    val expiresIn: Int,
    val intervalSec: Int,
)

/** 연결 상태 — 프론트가 'GitHub Copilot 연결' 버튼/대기 표시. */
data class OAuthStatus(
    val connected: Boolean,   // Copilot 사용 가능(GitHub 토큰 보유)
    val pending: Boolean,     // 디바이스 인증 대기 중(사용자가 코드 입력 대기)
    val error: String?,       // 마지막 인증 실패 사유(access_denied/expired_token 등)
)
