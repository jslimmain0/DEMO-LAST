package com.flowlink.mock

import com.fasterxml.jackson.databind.JsonNode
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Pattern
import java.time.Instant
import java.util.UUID

/** Mock 서버 관리 API DTO 모음(FolderDtos 패턴). */
object MockDtos {

    /** 이 Mock 을 호출하는 워크플로(현재 그래프에 base URL 포함). */
    data class FlowRef(val id: UUID, val name: String)

    /**
     * 목록 카드용 요약 — 라우트/TCP 요약(spec 에서 서버가 1회 추출·캐시), 살아있음 지표(요청 기록 기반), 현재 버전.
     * usedBy 는 별도 엔드포인트(`/usages`)로(플로우 그래프 스캔 비용).
     */
    data class MockServerSummary(
        val id: UUID,
        val name: String,
        val slug: String,
        val kind: String,
        val enabled: Boolean,
        val updatedAt: Instant,
        val workspaceId: UUID? = null,
        val routeCount: Int = 0,
        val methods: List<String> = emptyList(),   // 라우트 메서드(정의 순서, 중복 제거, 최대 6)
        val paths: List<String> = emptyList(),     // 라우트 경로(검색·카드 표시, 최대 6)
        val tcpPort: Int? = null,
        val tcpEnabled: Boolean? = null,
        val hasCodec: Boolean = false,
        val environment: String? = null,
        val lastRequestAt: Instant? = null,
        val recentRequests: Int = 0,               // 최근 60초 요청 수(살아있음 점)
        val requestCount: Int = 0,                 // 요청 기록 수(최근 100 상한)
        val currentVersion: Int = 0,
    )

    data class MockServerDetail(
        val id: UUID,
        val name: String,
        val slug: String,
        val kind: String,
        val enabled: Boolean,
        val spec: JsonNode,
        val createdAt: Instant,
        val updatedAt: Instant,
        val workspaceId: UUID? = null,
        val currentVersion: Int = 0,
    )

    /** 정의 스냅샷 요약(버전 기록 목록). */
    data class MockVersionSummary(
        val id: UUID,
        val versionNo: Int,
        val note: String?,
        val createdBy: String?,
        val createdAt: Instant,
        val pinned: Boolean,
        val routeCount: Int,
        val tcpPort: Int?,
    )

    // 요청 DTO: @get:JvmName 금지 — jackson-module-kotlin 이 오인식해 역직렬화가 깨진다(spec JsonNode 바인딩 등).
    // 호출부(MockServerService)가 Kotlin 이라 프로퍼티(.name/.spec)로 접근하므로 accessor 별칭도 불필요.
    data class CreateMockServerRequest(
        @field:NotBlank val name: String,
        @field:NotBlank @field:Pattern(
            regexp = "[a-z0-9-]{3,40}",
            message = "slug 는 소문자·숫자·하이픈 3~40자"
        ) val slug: String,
        // 유형 — "HTTP"(경로·응답) | "TCP"(소켓 전문). 미지정/그 외는 HTTP. (@get:JvmName 금지 규칙 준수)
        val type: String? = null,
        /** 소속 워크스페이스 — 'public'/null=공용, UUID=팀/개인. */
        val workspaceId: String? = null
    )

    data class UpdateMockServerRequest(
        val name: String?,
        val enabled: Boolean?,
        /** 워크스페이스 이동 — 'public'/null 무시(변경 없음), "public" 문자열=공용, UUID=팀/개인. 양쪽 쓰기 권한 필요. */
        val workspaceId: String? = null
    )

    /** spec 저장 — 내용이 바뀌었으면 버전 스냅샷 1개(note=커밋 메시지, pinned=📌 보존). */
    data class UpdateMockSpecRequest(
        val spec: JsonNode?,
        val note: String? = null,
        val pinned: Boolean? = null
    )

    data class PinRequest(val pinned: Boolean = true)

    /** 요청 기록 1건 — mock 에 온 실제 요청(디버깅·검증용). */
    /** TCP 미리보기 요청 — 편집 중 tcp 섹션(미저장) + 샘플 요청 전문(문자열, tcp.charset 으로 인코딩) + 코덱/시크릿 환경(미저장). */
    data class TcpPreviewRequest(
        val tcp: MockSpec.MockTcp?,
        val sample: String? = null,
        val codec: MockSpec.MockCodec? = null,
        val environment: String? = null,
    )

    /**
     * 코덱 시험 요청(HTTP) — 편집 중 코덱(미저장)을 샘플 전문에 적용해 단계별 결과를 본다. side=request|response.
     * 시크릿은 서버가 [environment] 스코프로 실제 값을 넣고, 결과 텍스트에서 시크릿 값은 마스킹.
     */
    data class CodecTryRequest(
        val codec: MockSpec.MockCodec?,
        val environment: String? = null,
        val side: String? = null,
        val message: String? = null,
        val headers: Map<String, String>? = null,
        val contentType: String? = null,
    )

    data class CodecTryResult(
        val result: String,
        val headers: Map<String, String>,
        val fields: Map<String, String>,
        val steps: List<MockCodec.StepTrace>,
    )

    data class MockRequestLog(
        val at: java.time.Instant,
        val method: String,
        val path: String,
        val query: Map<String, String>,
        val headers: Map<String, String>,
        val bodyText: String,
        val matchedRuleId: String?,
        val status: Int,
        val delayMs: Int,
        val callbackFired: Boolean,
        val decodedBody: String? = null, // 요청 코덱 적용 결과(코덱 없으면 null)
    )

    /** 런타임 상태 스냅샷 — 상태 있는 목 디버깅용. */
    data class MockStateView(
        val state: Map<String, String>,
        val seq: Long,
        val hits: Map<String, Int>,
        val requestCount: Int,
    )
}
