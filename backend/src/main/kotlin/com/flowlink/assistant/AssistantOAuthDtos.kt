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

/**
 * VS Code Copilot 상태 패널 수준의 종합 정보 — 연결 계정·요금제·쿼터 사용량·모델.
 * GitHub `/user` + `/copilot_internal/user`(quota_snapshots) 를 합쳐 구성.
 */
data class CopilotInfo(
    val connected: Boolean,
    val login: String?,          // GitHub 로그인(jslimmain0)
    val avatarUrl: String?,
    val plan: String?,           // copilot_plan: individual/business/enterprise
    val sku: String?,            // access_type_sku
    val chatEnabled: Boolean,
    val agentEnabled: Boolean,   // MCP/agent 모드 사용 가능
    val quotaResetDate: String?, // 쿼터 초기화일(2026-08-01)
    val quotas: List<QuotaSnapshot>,
    val currentModel: String,
    val tokenExpiresAt: Long?,   // Copilot 토큰 만료(epoch sec)
    val error: String? = null,   // 정보 조회 실패 사유(있으면 부분 정보)
)

/** 쿼터 스냅샷 한 종류 — premium_interactions(프리미엄 요청)/chat/completions. */
data class QuotaSnapshot(
    val id: String,              // premium_interactions/chat/completions
    val label: String,           // 한글 라벨
    val unlimited: Boolean,
    val percentRemaining: Double,
    val remaining: Double,
    val entitlement: Double,
    val used: Double,
    val overagePermitted: Boolean,
)
