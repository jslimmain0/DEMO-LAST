package com.flowlink.execution

import com.flowlink.core.domain.ExecutionStatus
import com.flowlink.execution.dto.ExecutionDetail
import com.flowlink.execution.dto.ExecutionSummary
import com.flowlink.execution.dto.ResumeRequest
import com.flowlink.execution.dto.RunRequest
import com.flowlink.execution.dto.SingleNodeRunResult
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import java.util.UUID

/**
 * 워크플로 실행 트리거 및 실행 이력/로그 조회.
 *
 * wait(콜백 대기) 노드의 외부 콜백(결제/인증 게이트웨이 노티)은 백엔드가 직접 받아 재개한다
 * ([com.flowlink.execution.RelayController] 의 {baseUrl}/relay/{실행ID}/cb/{노드ID}) — 별도 relay.js 불필요.
 * [resume] 은 브라우저 협업 노드(client HTTP / form / input)의 재개 전용이다.
 */
@RestController
@RequestMapping("/api/v1")
class ExecutionController(private val service: ExecutionService) {

    /** 수동 실행. (Phase 1: 동기 — 완료된 결과를 반환) */
    @PostMapping("/flows/{flowId}/runs")
    fun run(
        @PathVariable flowId: UUID,
        @RequestBody(required = false) req: RunRequest?
    ): ExecutionDetail = service.run(flowId, req)

    @GetMapping("/flows/{flowId}/runs")
    fun runsForFlow(
        @PathVariable flowId: UUID,
        @RequestParam(defaultValue = "50") limit: Int
    ): List<ExecutionSummary> = service.listForFlow(flowId, limit)

    /** 단일 노드 독립 실행 — 그 노드 하나만 새 컨텍스트로 즉석 실행(이력 미저장, 상류 바인딩 null). */
    @PostMapping("/flows/{flowId}/nodes/{nodeId}/run")
    fun runNode(
        @PathVariable flowId: UUID,
        @PathVariable nodeId: String,
        @RequestBody(required = false) req: RunRequest?
    ): SingleNodeRunResult = service.runSingleNode(flowId, nodeId, req)

    /**
     * TCP 요청 전문 미리보기(전송 없음) — 조립 바이트(hex)·필드 오프셋·오버플로.
     * 본문에 편집 중 노드를 실으면(미저장 편집 실시간 반영) 그걸, 없으면 저장된 그래프의 노드를 조립한다.
     * 순수 계산(SSRF/네트워크/DB 쓰기 없음)이라 본문 노드는 그대로 조립한다.
     */
    @PostMapping("/flows/{flowId}/nodes/{nodeId}/tcp-preview")
    fun tcpPreview(
        @PathVariable flowId: UUID,
        @PathVariable nodeId: String,
        @RequestBody(required = false) node: com.flowlink.core.graph.GraphNode?
    ): com.flowlink.execution.engine.TcpPreview = service.previewTcp(flowId, nodeId, node)

    /** 브라우저 협업 노드(client HTTP / form / wait)에서 중단된 실행을 재개한다. */
    @PostMapping("/executions/{id}/resume")
    fun resume(
        @PathVariable id: UUID,
        @RequestBody(required = false) req: ResumeRequest?
    ): ExecutionDetail = service.resume(id, req)

    @GetMapping("/executions/{id}")
    fun get(@PathVariable id: UUID): ExecutionDetail = service.get(id)

    /**
     * 실행 이력 조회. 파라미터가 없으면 최근순(기존 동작), status/flowId/from/to/offset 중 하나라도 있으면 필터 조회.
     * from/to 는 epoch millis(쿼리 파라미터 Instant 변환 이슈 회피).
     */
    @GetMapping("/executions")
    fun recent(
        @RequestParam(defaultValue = "50") limit: Int,
        @RequestParam(required = false) status: ExecutionStatus?,
        @RequestParam(required = false) flowId: UUID?,
        @RequestParam(required = false) from: Long?,
        @RequestParam(required = false) to: Long?,
        @RequestParam(defaultValue = "0") offset: Int,
        // 워크스페이스 스코프 — 'public'/미지정=공용, UUID=팀/개인. 항상 스코프 강제:
        // github 모드는 전원이 같은 테넌트라 "내 실행 한정" 전제가 성립하지 않아, 무스코프 무필터 경로가
        // 타 워크스페이스 실행 이력(flow 이름 포함)을 게스트에게 유출하던 구멍(적대 리뷰 [M]) 봉인.
        @RequestParam(required = false) workspaceId: String?,
    ): List<ExecutionSummary> =
        service.listFiltered(status, flowId, from, to, limit, offset, workspaceId)

    /** 같은 조건(원본 flowVersion+input)으로 재실행. */
    @PostMapping("/executions/{id}/rerun")
    fun rerun(@PathVariable id: UUID): ExecutionDetail = service.rerun(id)
}
