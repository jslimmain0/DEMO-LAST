package com.flowlink.mcp

import com.fasterxml.jackson.databind.ObjectMapper
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.core.annotation.Order
import org.springframework.core.env.Environment
import org.springframework.security.authentication.AbstractAuthenticationToken
import org.springframework.security.config.annotation.web.builders.HttpSecurity
import org.springframework.security.config.http.SessionCreationPolicy
import org.springframework.security.core.Authentication
import org.springframework.security.core.authority.SimpleGrantedAuthority
import org.springframework.security.oauth2.core.OAuth2AccessToken
import org.springframework.security.oauth2.core.OAuth2Token
import org.springframework.security.oauth2.server.authorization.InMemoryOAuth2AuthorizationService
import org.springframework.security.oauth2.server.authorization.OAuth2AuthorizationService
import org.springframework.security.oauth2.server.authorization.OAuth2TokenType
import org.springframework.security.oauth2.server.authorization.config.annotation.web.configurers.OAuth2AuthorizationServerConfigurer
import org.springframework.security.oauth2.server.authorization.context.AuthorizationServerContextHolder
import org.springframework.security.oauth2.server.authorization.settings.AuthorizationServerSettings
import org.springframework.security.oauth2.server.authorization.token.OAuth2TokenGenerator
import org.springframework.security.web.SecurityFilterChain
import org.springframework.security.web.authentication.LoginUrlAuthenticationEntryPoint
import org.springframework.security.web.context.HttpSessionSecurityContextRepository
import org.springframework.security.web.util.matcher.AntPathRequestMatcher
import org.springframework.security.web.util.matcher.OrRequestMatcher
import java.time.Instant
import java.util.Base64

/** OAuth code/PKCE/client authentication is owned by Spring Authorization Server. */
@Configuration(proxyBeanMethods = false)
class McpOAuthConfiguration {
    @Bean fun mcpClients(mapper: ObjectMapper, env: Environment) = McpClientRepository(mapper, env)
    @Bean fun mcpOAuthService(mapper: ObjectMapper, env: Environment, clients: McpClientRepository) = McpOAuthService(mapper, env, clients)
    @Bean fun mcpOAuthController(service: McpOAuthService, clients: McpClientRepository) = McpOAuthController(service, clients)
    @Bean fun mcpAuthorizations(): OAuth2AuthorizationService = InMemoryOAuth2AuthorizationService()
    @Bean fun mcpAuthorizationSettings(env: Environment): AuthorizationServerSettings {
        val builder = AuthorizationServerSettings.builder().authorizationEndpoint("/authorize").tokenEndpoint("/token")
        (env.getProperty("FLOWLINK_PUBLIC_URL") ?: env.getProperty("flowlink.runtime.public-url"))?.trim()?.trimEnd('/')?.takeIf { it.isNotBlank() }?.let {
            McpOAuthService.validatePublicUrl(it)
            builder.issuer(it)
        }
        return builder.build()
    }

    @Bean fun mcpAccessTokens(mapper: ObjectMapper): OAuth2TokenGenerator<OAuth2Token> = OAuth2TokenGenerator { ctx ->
        if (ctx.tokenType != OAuth2TokenType.ACCESS_TOKEN) return@OAuth2TokenGenerator null
        val principal = ctx.getPrincipal<Authentication>() as? McpLoginAuthentication ?: return@OAuth2TokenGenerator null
        val payload = mapper.readTree(Base64.getUrlDecoder().decode(principal.accessToken.split('.')[1]))
        val expiry = Instant.ofEpochSecond(payload.path("exp").asLong())
        if (!expiry.isAfter(Instant.now())) return@OAuth2TokenGenerator null
        OAuth2AccessToken(OAuth2AccessToken.TokenType.BEARER, principal.accessToken, Instant.now(), expiry, ctx.authorizedScopes)
    }

    @Bean @Order(0)
    fun mcpOAuthSecurity(http: HttpSecurity, clients: McpClientRepository, service: OAuth2AuthorizationService,
                         settings: AuthorizationServerSettings, generator: OAuth2TokenGenerator<OAuth2Token>): SecurityFilterChain {
        val oauth = OAuth2AuthorizationServerConfigurer()
        http.apply(oauth)
        oauth.registeredClientRepository(clients).authorizationService(service).authorizationServerSettings(settings).tokenGenerator(generator)
            .authorizationEndpoint { it.consentPage("/mcp-consent") }
            .authorizationServerMetadataEndpoint { endpoint -> endpoint.authorizationServerMetadataCustomizer { builder ->
                builder.claim("registration_endpoint", AuthorizationServerContextHolder.getContext().issuer + "/register")
                builder.claim("code_challenge_methods_supported", listOf("S256"))
            } }
        val publicPaths = arrayOf("/register", "/mcp-login", "/login/start", "/login/poll", "/.well-known/oauth-protected-resource/**", "/.well-known/oauth-authorization-server/mcp")
        http.securityMatcher(OrRequestMatcher(listOf(oauth.endpointsMatcher, AntPathRequestMatcher("/mcp-consent")) + publicPaths.map(::AntPathRequestMatcher)))
            .authorizeHttpRequests { auth -> auth.requestMatchers(*publicPaths).permitAll().anyRequest().authenticated() }
            .csrf { it.ignoringRequestMatchers(OrRequestMatcher(listOf(oauth.endpointsMatcher) + publicPaths.map(::AntPathRequestMatcher))) }
            .securityContext { it.securityContextRepository(HttpSessionSecurityContextRepository()) }
            .sessionManagement { it.sessionCreationPolicy(SessionCreationPolicy.IF_REQUIRED) }
            .exceptionHandling { it.authenticationEntryPoint(LoginUrlAuthenticationEntryPoint("/mcp-login")) }
        return http.build()
    }

    /** The servlet checks credentials against the management API and sends the MCP discovery challenge. */
    @Bean @Order(1)
    fun mcpTransportSecurity(http: HttpSecurity): SecurityFilterChain = http.securityMatcher("/mcp")
        .authorizeHttpRequests { it.anyRequest().permitAll() }.csrf { it.disable() }
        .sessionManagement { it.sessionCreationPolicy(SessionCreationPolicy.STATELESS) }.build()
}

internal class McpLoginAuthentication(private val login: String, internal val accessToken: String) :
    AbstractAuthenticationToken(listOf(SimpleGrantedAuthority("ROLE_MCP_USER"))) {
    init { isAuthenticated = true }
    override fun getCredentials(): Any = ""
    override fun getPrincipal(): Any = login
}
