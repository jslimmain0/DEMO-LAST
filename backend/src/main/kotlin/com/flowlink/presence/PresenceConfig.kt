package com.flowlink.presence

import com.flowlink.common.tenant.TenantContext
import com.flowlink.core.repository.FlowRepository
import com.flowlink.security.AuthProperties
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
    private val authProps: AuthProperties,
    private val flowRepository: FlowRepository,
    private val workspace: com.flowlink.workspace.WorkspaceService,
) : WebSocketConfigurer {

    override fun registerWebSocketHandlers(registry: WebSocketHandlerRegistry) {
        // flow 는 전역 공유 — 핸드셰이크에서 존재 확인 + **워크스페이스 롤 판정**(username 기준).
        // 비멤버/게스트는 팀·개인 flow 의 presence 방에 못 들어간다(편집 현황 노출 방지).
        val interceptor = PresenceHandshakeInterceptor(
            decoderProvider.getIfAvailable(), props.tenantClaim, authProps.githubEnabled,
        ) { id, username ->
            flowRepository.findByIdAndTenantId(id, TenantContext.SHARED_FLOW_TENANT)
                .map { workspace.roleFor(username, it.workspaceId) != null }.orElse(false)
        }
        registry.addHandler(handler, "/ws/presence")
            .addInterceptors(interceptor)
            .setAllowedOrigins("*")   // 사내 도구 전제 + 핸드셰이크에서 자체 검증(OIDC 모드)
    }
}
