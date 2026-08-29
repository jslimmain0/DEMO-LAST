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

    @PutMapping("/{id}/spec")
    fun updateSpec(@PathVariable id: UUID, @RequestBody req: UpdateMockSpecRequest): MockServerDetail =
        service.updateSpec(id, req.spec)

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
}
