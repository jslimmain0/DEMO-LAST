package com.flowlink.execution

import jakarta.servlet.http.HttpServletRequest
import org.slf4j.LoggerFactory
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.LinkedHashMap
import java.util.Locale
import java.util.UUID

/**
 * wait(콜백 대기) 노드의 콜백 수신 게이트웨이 — `/relay/{execId}/cb/{nodeId}` 전 메서드 캐치올.
 *
 * 결제/인증 게이트웨이나 서버 노티가 이 URL 로 콜백하면 백엔드가 직접 받아 실행을 재개한다
 * (별도 relay.js 없이 백엔드+프론트 2프로세스). 무인증(외부 시스템이 부르는 엔드포인트,
 * execId 는 추측 불가한 UUID) + CORS 오픈. 어떤 콜백 처리 오류도 다른 실행에 영향 주지 않도록
 * 전체 try/catch → 500 JSON 가드.
 *
 * GET/HEAD 는 쿼리스트링을, 그 외는 요청 본문(컨테이너가 urlencoded 를 파라미터로 소진했으면 복원)을
 * 콜백 본문으로 사용한다. 본문 파싱(JSON/urlencoded/원문)·노드 출력 병합은 재개 계약이 처리한다.
 */
@RestController
class RelayController(private val service: ExecutionService) {

    @RequestMapping(path = ["/relay/{execId}/cb/{nodeId}"])
    fun callback(
        @PathVariable execId: UUID,
        @PathVariable nodeId: String,
        request: HttpServletRequest
    ): ResponseEntity<String> {
        val method = request.method.uppercase(Locale.ROOT)
        if ("OPTIONS" == method) {
            return cors(ResponseEntity.ok()).header("Content-Type", "text/plain; charset=UTF-8").body("")
        }
        return try {
            val headers = collectHeaders(request)
            val bodyText = readBody(request, method)
            val resp = service.recordWaitCallback(execId, nodeId, method, headers, bodyText)
            cors(ResponseEntity.ok()).header("Content-Type", resp.contentType).body(resp.body)
        } catch (e: Exception) {
            log.warn(
                "[relay] 콜백 처리 오류(exec={}, node={}): {}",
                execId, nodeId, if (e.message == null) e.toString() else e.message
            )
            cors(ResponseEntity.status(500))
                .header("Content-Type", "application/json; charset=UTF-8")
                .body("{\"error\":\"relay 콜백 처리 오류\"}")
        }
    }

    /** GET/HEAD 는 쿼리스트링을 본문으로, 그 외는 요청 본문(빈 값이면 소진된 urlencoded 파라미터 복원). */
    private fun readBody(request: HttpServletRequest, method: String): String {
        if ("GET" == method || "HEAD" == method) {
            return request.queryString ?: ""
        }
        val bytes = request.inputStream.readAllBytes()
        if (bytes.isNotEmpty()) {
            return String(bytes, StandardCharsets.UTF_8)
        }
        // 컨테이너/FormContentFilter 가 urlencoded 본문을 파라미터로 소진해 스트림이 빈 경우 복원.
        return recoverFormBody(request)
    }

    /** 소진된 urlencoded 본문을 파라미터 맵에서 a=1&b=2 로 재조립(재개 계약이 다시 파싱한다). */
    private fun recoverFormBody(request: HttpServletRequest): String {
        val params = request.parameterMap ?: return ""
        if (params.isEmpty()) {
            return ""
        }
        val sb = StringBuilder()
        for ((k, values) in params) {
            for (v in values ?: emptyArray()) {
                if (sb.isNotEmpty()) {
                    sb.append('&')
                }
                sb.append(URLEncoder.encode(k, StandardCharsets.UTF_8))
                    .append('=')
                    .append(URLEncoder.encode(v ?: "", StandardCharsets.UTF_8))
            }
        }
        return sb.toString()
    }

    private fun collectHeaders(request: HttpServletRequest): Map<String, String> {
        val headers = LinkedHashMap<String, String>()
        val names = request.headerNames
        while (names != null && names.hasMoreElements()) {
            val n = names.nextElement()
            headers.putIfAbsent(n.lowercase(Locale.ROOT), request.getHeader(n))
        }
        return headers
    }

    private fun cors(b: ResponseEntity.BodyBuilder): ResponseEntity.BodyBuilder =
        b.header("Access-Control-Allow-Origin", "*")
            .header("Access-Control-Allow-Methods", "*")
            .header("Access-Control-Allow-Headers", "*")

    companion object {
        private val log = LoggerFactory.getLogger(RelayController::class.java)
    }
}
