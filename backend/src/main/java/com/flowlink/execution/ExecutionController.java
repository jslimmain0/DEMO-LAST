package com.flowlink.execution;

import com.flowlink.execution.dto.ExecutionDetail;
import com.flowlink.execution.dto.ExecutionSummary;
import com.flowlink.execution.dto.ResumeRequest;
import com.flowlink.execution.dto.RunRequest;
import com.flowlink.execution.engine.CallbackRegistry;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** 워크플로 실행 트리거, 실행 이력/로그 조회, 콜백 수신(relay). */
@RestController
@RequestMapping("/api/v1")
public class ExecutionController {

    private final ExecutionService service;

    public ExecutionController(ExecutionService service) {
        this.service = service;
    }

    /** 수동 실행. (Phase 1: 동기 — 완료 또는 중단(WAITING) 상태를 반환) */
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

    /** 중단된 실행을 브라우저 입력(FORM 팝업 결과/INPUT 값/client HTTP 응답)으로 재개한다. */
    @PostMapping("/executions/{id}/resume")
    public ExecutionDetail resume(@PathVariable UUID id,
                                  @RequestBody(required = false) ResumeRequest req) {
        return service.resume(id, req);
    }

    /** 대기 중 실행을 중단(⏹)한다 — 서스펜션 해제 + CANCELLED. 대기 아님이면 현재 상태(멱등). */
    @PostMapping("/executions/{id}/cancel")
    public ExecutionDetail cancel(@PathVariable UUID id) {
        return service.cancel(id);
    }

    @GetMapping("/executions/{id}")
    public ExecutionDetail get(@PathVariable UUID id) {
        return service.get(id);
    }

    @GetMapping("/executions")
    public List<ExecutionSummary> recent(@RequestParam(defaultValue = "50") int limit) {
        return service.listRecent(limit);
    }

    /**
     * 콜백 수신부(relay) — wait(콜백 대기) 노드의 실행별 수신 URL. 모든 메서드 허용:
     * <ul>
     *   <li>GET 리다이렉트({@code returnUrl?resultCode=...}) → 쿼리스트링을 본문처럼 취급</li>
     *   <li>POST 자동전송(urlencoded) → 서블릿 파라미터로 병합 수신</li>
     *   <li>JSON/기타 본문 → 원문을 읽어 JSON → a=1&b=2 → 원문 순으로 파싱</li>
     * </ul>
     * 응답은 그 wait 노드에 등록된 것(형식+본문, 미등록이면 text/plain "OK")을 그대로 돌려준다 —
     * 인증창 콜백이면 "창을 닫으세요" HTML 이 팝업에 표시되고, 승인 노티면 게이트웨이가 ACK 를 받는 식.
     * 인증 없는(permitAll) 엔드포인트 — 실행ID(UUID)가 사실상의 비밀값 역할을 한다(사내 테스트망 전제).
     */
    @RequestMapping("/cb/{execId}/{nodeId}")
    public ResponseEntity<String> nodeCallback(@PathVariable UUID execId, @PathVariable String nodeId,
                                               HttpServletRequest request) throws IOException {
        // urlencoded POST 는 getParameterMap() 이 본문을 소비/병합하므로 먼저 읽는다(GET 쿼리 포함).
        Map<String, String[]> params = request.getParameterMap();
        String contentType = request.getContentType();
        boolean formEncoded = contentType != null
                && contentType.toLowerCase().contains("application/x-www-form-urlencoded");
        String rawBody = null;
        if (!formEncoded && !"GET".equalsIgnoreCase(request.getMethod())) {
            rawBody = new String(request.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        }
        CallbackRegistry.Reply reply = service.recordNodeCallback(
                execId, nodeId, request.getMethod(), request.getRequestURL().toString(), params, rawBody);
        return ResponseEntity.ok().contentType(MediaType.parseMediaType(reply.contentType())).body(reply.body());
    }
}
