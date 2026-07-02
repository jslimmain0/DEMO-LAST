package com.flowlink.execution;

import com.flowlink.execution.dto.ExecutionDetail;
import com.flowlink.execution.dto.ExecutionSummary;
import com.flowlink.execution.dto.ResumeRequest;
import com.flowlink.execution.dto.RunRequest;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.UUID;

/**
 * 워크플로 실행 트리거 및 실행 이력/로그 조회.
 *
 * <p>외부 콜백(결제/인증 게이트웨이 노티)은 백엔드가 직접 받지 않는다 — 별도 relay(relay.js)가
 * {relay}/cb/{실행ID}/{노드ID} 로 수신해 SSE 로 브라우저에 전달하고, 브라우저가 {@code resume} 으로
 * 실행을 이어간다. (설계: docs/superpowers/specs/2026-07-03-form-wait-relay-design.md)
 */
@RestController
@RequestMapping("/api/v1")
public class ExecutionController {

    private final ExecutionService service;

    public ExecutionController(ExecutionService service) {
        this.service = service;
    }

    /** 수동 실행. (Phase 1: 동기 — 완료된 결과를 반환) */
    @PostMapping("/flows/{flowId}/runs")
    public ExecutionDetail run(@PathVariable UUID flowId,
                               @RequestBody(required = false) RunRequest req) {
        return service.run(flowId, req);
    }

    @GetMapping("/flows/{flowId}/runs")
    public List<ExecutionSummary> runsForFlow(@PathVariable UUID flowId,
                                              @RequestParam(defaultValue = "50") int limit) {
        return service.listForFlow(flowId, limit);
    }

    /** 브라우저 협업 노드(client HTTP / form / wait)에서 중단된 실행을 재개한다. */
    @PostMapping("/executions/{id}/resume")
    public ExecutionDetail resume(@PathVariable UUID id,
                                  @RequestBody(required = false) ResumeRequest req) {
        return service.resume(id, req);
    }

    @GetMapping("/executions/{id}")
    public ExecutionDetail get(@PathVariable UUID id) {
        return service.get(id);
    }

    @GetMapping("/executions")
    public List<ExecutionSummary> recent(@RequestParam(defaultValue = "50") int limit) {
        return service.listRecent(limit);
    }
}
