package com.flowlink.presence

import com.flowlink.core.repository.FlowRepository
import com.flowlink.security.SecurityProperties
import org.springframework.beans.factory.ObjectProvider
import org.springframework.context.annotation.Configuration
import org.springframework.security.oauth2.jwt.JwtDecoder
import org.springframework.web.socket.config.annotation.EnableWebSocket
import org.springframework.web.socket.config.annotation.WebSocketConfigurer
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry

/** presence WebSocket 등록 — 경로 /ws/presence, 핸드셰이크에서 인증·테넌트 검증. */
@Configuration
@EnableWebSocket
class PresenceConfig(
    private val handler: PresenceHandler,
    private val decoderProvider: ObjectProvider<JwtDecoder>,
    private val props: SecurityProperties,
    private val flowRepository: FlowRepository,
) : WebSocketConfigurer {

    override fun registerWebSocketHandlers(registry: WebSocketHandlerRegistry) {
        val interceptor = PresenceHandshakeInterceptor(
            decoderProvider.getIfAvailable(), props.tenantClaim,
        ) { id, tenant -> flowRepository.findByIdAndTenantId(id, tenant).isPresent }
        registry.addHandler(handler, "/ws/presence")
            .addInterceptors(interceptor)
            .setAllowedOrigins("*")   // 사내 도구 전제 + 핸드셰이크에서 자체 검증(OIDC 모드)
    }
}
