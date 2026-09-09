package com.flowlink.mock

import com.flowlink.mock.MockDtos.CreateMockServerRequest
import com.flowlink.mock.MockDtos.MockServerDetail
import com.flowlink.mock.MockDtos.MockServerSummary
import com.flowlink.mock.MockDtos.UpdateMockServerRequest
import com.flowlink.mock.MockDtos.UpdateMockSpecRequest
import jakarta.validation.Valid
import org.springframework.http.HttpStatus
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PatchMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController
import java.util.UUID

/** Mock 서버 관리 CRUD (테넌트 스코프). 서빙은 [MockGatewayController]. */
@RestController
@RequestMapping("/api/v1/mock-servers")
class MockServerController(private val service: MockServerService) {

    @GetMapping
    fun list(@org.springframework.web.bind.annotation.RequestParam(required = false) workspaceId: String?): List<MockServerSummary> =
        service.list(workspaceId)

    /** slug 실시간 가용성 체크 — 생성 폼이 타이핑 중에 충돌을 미리 알려준다(제출 후 400 대신). */
    @GetMapping("/slug-check")
    fun slugCheck(@org.springframework.web.bind.annotation.RequestParam slug: String): Map<String, Any> =
        mapOf("slug" to slug, "available" to service.slugAvailable(slug))

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    fun create(@Valid @RequestBody req: CreateMockServerRequest): MockServerDetail = service.create(req)

    @GetMapping("/{id}")
    fun get(@PathVariable id: UUID): MockServerDetail = service.get(id)

    @PatchMapping("/{id}")
    fun update(@PathVariable id: UUID, @RequestBody req: UpdateMockServerRequest): MockServerDetail =
        service.updateMeta(id, req)

    /** 이 워크스페이스 Mock 들의 사용처(워크플로) — mockId → [{id,name}]. */
    @GetMapping("/usages")
    fun usages(@org.springframework.web.bind.annotation.RequestParam(required = false) workspaceId: String?): Map<UUID, List<MockDtos.FlowRef>> =
        service.usages(workspaceId)

    @GetMapping("/{id}/versions")
    fun versions(@PathVariable id: UUID): List<MockDtos.MockVersionSummary> = service.listVersions(id)

    @GetMapping("/{id}/versions/{no}")
    fun version(@PathVariable id: UUID, @PathVariable no: Int): com.fasterxml.jackson.databind.JsonNode = service.getVersionSpec(id, no)

    @PostMapping("/{id}/versions/{no}/restore")
    fun restore(@PathVariable id: UUID, @PathVariable no: Int): MockDtos.MockVersionSummary = service.restoreVersion(id, no)

    @PutMapping("/{id}/versions/{no}/pin")
    fun pin(@PathVariable id: UUID, @PathVariable no: Int, @RequestBody req: MockDtos.PinRequest): MockDtos.MockVersionSummary =
        service.setVersionPinned(id, no, req.pinned)

    @PutMapping("/{id}/spec")
    fun updateSpec(@PathVariable id: UUID, @RequestBody req: UpdateMockSpecRequest): MockServerDetail =
        service.updateSpec(id, req.spec, req.note, req.pinned == true)

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun delete(@PathVariable id: UUID) {
        service.delete(id)
    }

    // 요청 기록(journal) — mock 에 온 실제 요청 조회/비우기(디버깅·검증)
    @GetMapping("/{id}/requests")
    fun requests(@PathVariable id: UUID): List<MockDtos.MockRequestLog> = service.requests(id)

    @DeleteMapping("/{id}/requests")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun clearRequests(@PathVariable id: UUID) = service.clearRequests(id)

    // 런타임 상태(상태 있는 목) 초기화 / 조회
    @PostMapping("/{id}/reset")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun reset(@PathVariable id: UUID) = service.reset(id)

    @GetMapping("/{id}/state")
    fun state(@PathVariable id: UUID): MockDtos.MockStateView = service.runtimeState(id)

    /**
     * TCP 전문 미리보기 — 편집 중인 tcp 섹션 + 샘플 요청으로 요청 필드 분해·매칭 규칙·응답 바이트(hex/필드 오프셋/절단·패딩)를
     * 계산만 한다(저장·소켓 없음). 필드 모드 응답을 눈으로 확인하는 용도.
     */
    @PostMapping("/tcp-preview")
    fun tcpPreview(@RequestBody req: MockDtos.TcpPreviewRequest): TcpMockEngine.Preview = service.previewTcp(req)

    /** 코덱 시험(HTTP) — 미저장 코덱 + 샘플 전문 → 단계별 입력/출력(저장·소켓 없음). 시크릿 값이 쓰이므로 승인 사용자 + 읽기 권한. */
    @PostMapping("/{id}/codec-try")
    fun codecTry(@PathVariable id: UUID, @RequestBody req: MockDtos.CodecTryRequest): MockDtos.CodecTryResult = service.tryCodec(id, req)
}
