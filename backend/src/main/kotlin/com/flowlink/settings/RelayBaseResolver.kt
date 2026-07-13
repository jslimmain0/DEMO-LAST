package com.flowlink.settings

import com.flowlink.execution.config.ExecutionProperties
import org.springframework.stereotype.Component
import org.springframework.web.context.request.RequestContextHolder
import org.springframework.web.context.request.ServletRequestAttributes

/**
 * wait 콜백 수신 base URL 결정 — 우선순위:
 *  ① 화면(설정)에서 저장한 값(DB)
 *  ② env/설정파일 명시값(`flowlink.execution.relay.base-url` / `FLOWLINK_EXECUTION_RELAY_BASEURL`)
 *  ③ 현재 요청의 접속 주소(오리진) 자동 — 사용자가 브라우저로 접속한 그 주소가 곧 서버의 도달 가능한 주소
 *  ④ (요청 컨텍스트가 없을 때) localhost 폴백
 */
@Component
class RelayBaseResolver(
    private val settings: SettingsService,
    private val props: ExecutionProperties,
) {

    fun resolve(): String {
        val saved = settings.relayBaseUrl()
        if (!saved.isNullOrBlank()) {
            return saved.trim().trimEnd('/')
        }
        val configured = props.relay.configured
        if (configured != null) {
            return configured
        }
        return requestOrigin() ?: "http://localhost:18080"
    }

    /** 현재 HTTP 요청의 접속 오리진(scheme://host[:port]). 요청 스레드가 아니면 null. */
    fun requestOrigin(): String? {
        val attrs = RequestContextHolder.getRequestAttributes() as? ServletRequestAttributes ?: return null
        val req = attrs.request
        val scheme = req.scheme ?: "http"
        val host = req.serverName ?: return null
        val port = req.serverPort
        val defaultPort = (scheme == "http" && port == 80) || (scheme == "https" && port == 443)
        return if (defaultPort || port <= 0) "$scheme://$host" else "$scheme://$host:$port"
    }
}
