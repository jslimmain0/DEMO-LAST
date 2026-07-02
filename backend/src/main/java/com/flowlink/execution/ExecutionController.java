package com.flowlink.execution;

import com.flowlink.common.json.JsonService;
import com.flowlink.execution.dto.ExecutionDetail;
import com.flowlink.execution.dto.ExecutionSummary;
import com.flowlink.execution.dto.ResumeRequest;
import com.flowlink.execution.dto.RunRequest;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;
import java.util.UUID;

/** 워크플로 실행 트리거 및 실행 이력/로그 조회. */
@RestController
@RequestMapping("/api/v1")
public class ExecutionController {

    private final ExecutionService service;
    private final JsonService json;

    public ExecutionController(ExecutionService service, JsonService json) {
        this.service = service;
        this.json = json;
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

    /** client(클라이언트→서버) 모드 노드에서 중단된 실행을, 브라우저가 호출한 결과로 재개한다. */
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

    /**
     * 게이트웨이/팝업 콜백 수신부 — 폼 전송(WAIT) 노드가 발급한 {@code {{ __callbackUrl }}} 이 이 경로로 되돌아온다.
     * GET(쿼리 리다이렉트) / POST(자동전송) 모두 서블릿이 파라미터로 병합하므로 하나의 핸들러로 처리한다.
     * 인증 없는(permitAll) 엔드포인트 — 실행/테넌트는 추측 불가능한 토큰으로만 되찾는다(SecurityConfig 주석 참조).
     *
     * <p>파라미터를 재개 상태에 저장(authoritative)한 뒤, 팝업(=지금 이 응답을 렌더링)이 opener 로 결과를
     * postMessage 하고 스스로 닫는 <b>브리지 HTML</b> 을 돌려준다 → 기존 FormPopupDialog 재개 루프를 그대로 재사용.
     */
    @RequestMapping(value = "/executions/callback/{token}",
            method = {RequestMethod.GET, RequestMethod.POST},
            produces = MediaType.TEXT_HTML_VALUE)
    public ResponseEntity<String> callback(@PathVariable String token, HttpServletRequest request) {
        Map<String, Object> params = service.recordCallback(token, request.getParameterMap());
        // JSON 을 <script> 안에 심으므로 </script> 브레이크아웃 방지 위해 <,>,& 를 유니코드 이스케이프
        String safe = json.toJson(params)
                .replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026");
        return ResponseEntity.ok().contentType(MediaType.TEXT_HTML).body(bridgePage(safe));
    }

    /**
     * 고정(사전등록) 콜백 수신부 — 실행마다 안 바뀌는 안정 URL({@code {{ __notiUrl }}}). 게이트웨이 콘솔에 미리 등록하거나
     * 서버 간 노티(웹훅)로 쓴다. 파라미터에 실려온 상관키({@code {{ __corrId }}} echo)로 대기 실행을 찾아 서버 사이드로 재개.
     *
     * <p>브라우저(팝업)가 이 URL 로 리다이렉트한 경우엔 브리지 HTML(결과 relay + 닫기)을, 서버 간 노티엔 게이트웨이용 {@code OK}
     * 텍스트를 돌려준다(Accept 헤더로 구분). 재개는 멱등이라 팝업/노티가 병행돼도 안전하다.
     */
    @RequestMapping(value = "/callbacks",
            method = {RequestMethod.GET, RequestMethod.POST})
    public ResponseEntity<String> fixedCallback(HttpServletRequest request) {
        Map<String, Object> params = service.recordFixedCallback(request.getParameterMap());
        String accept = request.getHeader("Accept");
        boolean browser = accept != null && accept.contains("text/html");
        if (browser) {
            String safe = json.toJson(params)
                    .replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026");
            return ResponseEntity.ok().contentType(MediaType.TEXT_HTML).body(bridgePage(safe));
        }
        // 서버 간 노티: 게이트웨이가 기대하는 ACK. (PG 별 규격 상이 — 데모는 평문 OK)
        return ResponseEntity.ok().contentType(MediaType.TEXT_PLAIN).body("OK");
    }

    /** 콜백 결과를 opener(FlowLink 에디터)로 전달하고 자동으로 닫히는 최소 브리지 페이지. */
    private static String bridgePage(String paramsJson) {
        return "<!doctype html><html lang=\"ko\"><head><meta charset=\"utf-8\">"
                + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
                + "<title>처리 완료</title></head>"
                + "<body style=\"font-family:system-ui,-apple-system,sans-serif;padding:28px;color:#333;\">"
                + "<p>결과를 전달하는 중입니다… 이 창은 잠시 후 자동으로 닫힙니다.</p>"
                + "<script>(function(){var d=" + paramsJson + ";try{if(window.opener){"
                + "window.opener.postMessage(Object.assign({__flcallback:true},d),'*');}}catch(e){}"
                + "setTimeout(function(){try{window.close();}catch(e){}},300);})();</script>"
                + "</body></html>";
    }
}
