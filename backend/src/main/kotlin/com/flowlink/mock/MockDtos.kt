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
        val routeLabels: List<String> = emptyList(),  // "GET /pay" — 목록 카드 라우트 미니 스트립(앞 8개)
        val tcpRuleCount: Int = 0,
        val tcpFieldCount: Int = 0,
        val hasCodec: Boolean = false,
        val environment: String? = null,
        val lastRequestAt: Instant? = null,
        val recentRequests: Int = 0,               // 최근 60초 요청 수(살아있음 점)
        val requestCount: Int = 0,                 // 요청 기록 수(최근 100 상한)
        val unmatchedRequests: Int = 0,            // 규칙 무매칭(404) 요청 수 — 대시보드 현황/필터
        val currentVersion: Int = 0,
    )

    // ---------- 서버 현황(fleet) — 모든 워크스페이스의 Mock 을 "실제 서버처럼" 한 화면에 ----------

    /** 워크스페이스 한 줄 — myRole=null 은 접근 불가(이름·개수만), mine=내 소속(공용·내 개인·멤버인 팀). */
    data class FleetWorkspace(
        val id: String,            // 'public' 또는 UUID
        val name: String,
        val kind: String,          // PUBLIC | PERSONAL | TEAM
        val myRole: String?,       // OWNER | EDITOR | VIEWER | null(접근 불가)
        val mine: Boolean,
        val ownerUsername: String? = null,
    )

    /**
     * 서버 한 대 — readable=false(접근 권한 없는 워크스페이스)면 이름·slug·종류·켜짐·포트·살아있음만 싣고
     * 라우트 목록/경로/환경 같은 정의 내용은 비운다(서빙 주소·포트는 어차피 전역 자원이라 노출 — 정의는 비공개).
     */
    data class FleetServer(
        val id: UUID,
        val name: String,
        val slug: String,
        val kind: String,
        val enabled: Boolean,
        val workspaceId: String,   // 'public' 또는 UUID
        val readable: Boolean,
        val myRole: String?,
        val tcpPort: Int? = null,
        val tcpEnabled: Boolean? = null,
        val listening: Boolean = false,      // TCP: 지금 소켓이 열려 있는가(spec 이 아니라 실제 리스너)
        val listenError: String? = null,     // 켜져 있어야 하는데 안 열림(기동 시 바인딩 실패 등)
        val routeCount: Int = 0,
        val routeLabels: List<String> = emptyList(),
        val tcpRuleCount: Int = 0,
        val tcpFieldCount: Int = 0,
        val hasCodec: Boolean = false,
        val environment: String? = null,
        val lastRequestAt: Instant? = null,
        val recentRequests: Int = 0,
        val requestCount: Int = 0,
        val unmatchedRequests: Int = 0,
        val currentVersion: Int = 0,
        val updatedAt: Instant? = null,
        val usedBy: List<FlowRef> = emptyList(),   // 이 Mock 의 base URL 을 현재 그래프에 가진(읽을 수 있는) 워크플로 — readable 일 때만
    )

    /** 포트 한 줄 — HTTP 게이트웨이(앱 포트, 켜진 HTTP Mock 수) + TCP 리스너(mock 별). state=LISTENING | FAILED | OFF. */
    data class FleetPort(
        val port: Int,
        val kind: String,          // HTTP | TCP
        val state: String,
        val mockId: UUID? = null,
        val mockName: String? = null,
        val slug: String? = null,
        val workspaceId: String? = null,
        val readable: Boolean = true,
        val count: Int = 1,        // HTTP 게이트웨이: 서빙 중인 Mock 수
        val error: String? = null,
    )

    data class MockFleet(
        val workspaces: List<FleetWorkspace>,
        val servers: List<FleetServer>,
        val ports: List<FleetPort>,
        val httpPort: Int,
        val contextPath: String,
        val generatedAt: Instant,
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
