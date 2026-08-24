package com.flowlink.common.startup

import com.flowlink.assistant.AssistantProperties
import com.flowlink.common.crypto.CryptoProvider
import com.flowlink.core.domain.TriggerType
import com.flowlink.core.repository.ExecutionRepository
import com.flowlink.core.repository.ExecutionSuspensionRepository
import com.flowlink.core.repository.FlowRepository
import com.flowlink.core.repository.FlowTriggerRepository
import com.flowlink.core.repository.MockServerRepository
import com.flowlink.core.repository.SecretRepository
import com.flowlink.execution.config.ExecutionProperties
import com.flowlink.execution.engine.StateCrypto
import com.flowlink.mock.TcpMockRegistry
import com.flowlink.secret.VaultProperties
import com.flowlink.security.AuthProperties
import com.flowlink.security.SecurityProperties
import com.flowlink.transform.TransformRegistry
import org.flywaydb.core.Flyway
import org.slf4j.LoggerFactory
import org.springframework.beans.factory.ObjectProvider
import org.springframework.boot.context.event.ApplicationReadyEvent
import org.springframework.core.Ordered
import org.springframework.core.annotation.Order
import org.springframework.core.env.Environment
import org.springframework.context.event.EventListener
import org.springframework.security.oauth2.jwt.JwtDecoder
import org.springframework.stereotype.Component
import java.lang.management.ManagementFactory
import java.time.Duration
import java.time.ZoneId
import javax.sql.DataSource

/**
 * 기동 시 "이 프로세스가 무엇을 물고 올라왔는지"를 한 블록으로 남기는 요약 로거.
 *
 * 로그 파일만 보고도 **어떤 설정으로 뜬 서버인지**(DB·인증 모드·암호화 키 출처·Vault·AI 자격·실행 정책·
 * 로드된 플러그인/Mock/트리거)를 알 수 있게 한다. 운영 이슈 대부분이 "그 서버가 어떤 env 로 떴나"에서
 * 갈리므로, 각 항목은 **실제 적용값(effective)** 을 찍는다(설정 파일 값이 아니라 빈이 결정한 값).
 *
 * - [ApplicationReadyEvent] + 최저 우선순위 → TCP mock 기동·시크릿 백필·실행 복구가 **끝난 뒤** 찍힌다.
 * - 어떤 항목도 기동을 실패시키지 않는다(전 구간 방어적 try/catch — 요약 로그가 서버를 죽이면 안 된다).
 * - 비밀값은 절대 찍지 않는다(토큰/비밀번호/시크릿 값은 설정 여부·출처만).
 */
@Component
@Order(Ordered.LOWEST_PRECEDENCE)
class StartupSummaryLogger(
    private val env: Environment,
    private val execProps: ExecutionProperties,
    private val authProps: AuthProperties,
    private val securityProps: SecurityProperties,
    private val vaultProps: VaultProperties,
    private val assistantProps: AssistantProperties,
    private val crypto: CryptoProvider,
    private val transforms: TransformRegistry,
    private val tcpMocks: TcpMockRegistry,
    private val dataSource: ObjectProvider<DataSource>,
    private val flyway: ObjectProvider<Flyway>,
    private val jwtDecoder: ObjectProvider<JwtDecoder>,
    private val flowRepo: ObjectProvider<FlowRepository>,
    private val execRepo: ObjectProvider<ExecutionRepository>,
    private val suspensionRepo: ObjectProvider<ExecutionSuspensionRepository>,
    private val secretRepo: ObjectProvider<SecretRepository>,
    private val mockRepo: ObjectProvider<MockServerRepository>,
    private val triggerRepo: ObjectProvider<FlowTriggerRepository>,
) {

    @EventListener(ApplicationReadyEvent::class)
    fun logSummary() {
        val lines = ArrayList<String>()
        lines += "╔══════════════════ FlowLink 기동 요약 ══════════════════"
        section(lines, "앱") { app() }
        section(lines, "서버") { server() }
        section(lines, "DB") { db() }
        section(lines, "인증") { auth() }
        section(lines, "암호화") { cryptoInfo() }
        section(lines, "Vault") { vault() }
        section(lines, "AI") { assistant() }
        section(lines, "실행") { execution() }
        section(lines, "변환") { transformsInfo() }
        section(lines, "Mock") { mocks() }
        section(lines, "트리거") { triggers() }
        section(lines, "데이터") { data() }
        section(lines, "경로") { endpoints() }
        lines += "╚══════════════════ 기동 완료 (JVM ${uptimeSec()}초) ══════════════════"
        log.info("\n{}", lines.joinToString("\n"))
    }

    /** 한 섹션 — 실패해도 그 줄만 '(수집 실패)' 로 남기고 나머지 요약은 계속 찍는다. */
    private fun section(out: MutableList<String>, label: String, body: () -> List<String>) {
        val values = try {
            body()
        } catch (e: Exception) {
            listOf("(수집 실패: ${e.message ?: e.toString()})")
        }
        val head = "║ " + label + " ".repeat(maxOf(1, LABEL_COLS - displayWidth(label))) + ": "
        val cont = "║ " + " ".repeat(LABEL_COLS + 2)
        values.forEachIndexed { i, v -> out += (if (i == 0) head else cont) + v }
    }

    /** 한글(전각)은 두 칸을 차지 — 라벨 열 폭을 눈에 보이는 폭 기준으로 맞춘다. */
    private fun displayWidth(s: String): Int =
        s.fold(0) { acc, c ->
            acc + if (c.code in 0xAC00..0xD7A3 || c.code in 0x1100..0x11FF || c.code in 0x3130..0x318F) 2 else 1
        }

    private fun app(): List<String> {
        val name = env.getProperty("spring.application.name") ?: "flowlink"
        val version = javaClass.`package`?.implementationVersion ?: "dev"
        val profiles = env.activeProfiles.toList().ifEmpty { listOf("(default)") }
        return listOf(
            "$name v$version · profiles=$profiles · pid=${ProcessHandle.current().pid()}",
            "java ${System.getProperty("java.version")} · ${System.getProperty("os.name")} · " +
                "tz=${ZoneId.systemDefault()} · 파일인코딩=${System.getProperty("file.encoding")}",
        )
    }

    private fun server(): List<String> {
        val port = env.getProperty("local.server.port") ?: env.getProperty("server.port") ?: "18080"
        val shutdown = env.getProperty("server.shutdown") ?: "immediate"
        val out = arrayListOf("http://localhost:$port · shutdown=$shutdown")
        if (System.getenv("FLOWLINK_TLS_INSECURE")?.lowercase() in setOf("true", "1", "yes")) {
            out += "⚠ FLOWLINK_TLS_INSECURE — 아웃바운드 TLS 검증 전면 해제(사내망 전용)"
        }
        return out
    }

    private fun db(): List<String> {
        val ds = dataSource.getIfAvailable() ?: return listOf("(DataSource 없음)")
        val out = ArrayList<String>()
        ds.connection.use { c ->
            val md = c.metaData
            out += "${md.databaseProductName} ${md.databaseProductVersion} · user=${md.userName ?: "-"}"
            out += "url=${maskUrl(md.url)}"
        }
        val ddl = env.getProperty("spring.jpa.hibernate.ddl-auto") ?: "none"
        val fw = flyway.getIfAvailable()
        val schema = if (fw != null) {
            val info = fw.info()
            val applied = info.applied().size
            val current = info.current()?.version?.version ?: "-"
            "Flyway ON(적용 ${applied}건, 현재 v$current, locations=${env.getProperty("spring.flyway.locations") ?: "-"})"
        } else {
            "Flyway OFF"
        }
        out += "스키마: hibernate ddl-auto=$ddl · $schema"
        val pool = env.getProperty("spring.datasource.hikari.maximum-pool-size") ?: "10"
        out += "커넥션풀: ${env.getProperty("spring.datasource.hikari.pool-name") ?: "HikariPool"} (최대 $pool)"
        return out
    }

    private fun auth(): List<String> {
        val hasDecoder = jwtDecoder.getIfAvailable() != null
        val issuer = env.getProperty("spring.security.oauth2.resourceserver.jwt.issuer-uri")
        val out = ArrayList<String>()
        when {
            hasDecoder && authProps.githubEnabled -> {
                out += "GitHub 게스트 모드 — 앱은 로그인 없이 개방, /api/v1/assistant/** 만 로그인 필수"
                out += "허용 계정: " + if (authProps.allowedLogins.isEmpty()) {
                    "⚠ 전체 허용(FLOWLINK_AUTH_ALLOWED_LOGINS 미설정)"
                } else {
                    "화이트리스트 ${authProps.allowedLogins.size}명 ${authProps.allowedLogins}"
                }
                out += "앱 JWT: HS256 · TTL ${authProps.tokenTtlHours}h · client_id=${authProps.clientId}"
            }
            hasDecoder -> out += "OIDC 리소스 서버 + RBAC · issuer=${issuer ?: "-"}"
            else -> out += "⚠ dev 모드(permitAll) — 인증 없음. 운영은 FLOWLINK_AUTH_GITHUB_ENABLED=true 또는 issuer-uri 설정"
        }
        out += "테넌트 클레임='${securityProps.tenantClaim}' · CORS 허용=${securityProps.corsOrigins}"
        return out
    }

    private fun cryptoInfo(): List<String> {
        val t = vaultProps.transit
        return if (t.enabled) {
            listOf("Vault Transit(KEK) — mount=${t.mount}, key=${t.key} (+레거시 읽기 폴백) · 키가 앱 밖에 있음")
        } else {
            val dev = (crypto as? StateCrypto)?.isDevKey ?: false
            listOf(
                "로컬 AES-GCM · 키 출처=" +
                    if (dev) "⚠ dev 고정키(FLOWLINK_EXECUTION_STATE_SECRET 미설정)" else "FLOWLINK_EXECUTION_STATE_SECRET",
            )
        }
    }

    private fun vault(): List<String> {
        if (!vaultProps.enabled) return listOf("비활성(DB 시크릿만 사용)")
        val authMode = if (vaultProps.approle.configured) {
            "AppRole 로그인(mount=${vaultProps.approle.mount}, 자동 갱신)"
        } else if (vaultProps.token != null) {
            "static 토큰(env)"
        } else {
            "⚠ 인증 정보 없음"
        }
        return listOf(
            "${vaultProps.address} · KV v2 mount=${vaultProps.mount} · 인증=$authMode",
            "워크플로 시크릿 경로=${vaultProps.mount}/${vaultProps.path} · 앱 설정 비밀 경로=${vaultProps.mount}/${vaultProps.configPath} · 캐시 ${vaultProps.refreshSeconds}초",
        )
    }

    private fun assistant(): List<String> {
        val key = if (assistantProps.apiKey != null) "env/yml api-key 설정됨" else "env 키 없음(→ Copilot 연결 / 볼트 anthropic-api-key / stub 순으로 런타임 결정)"
        return listOf(
            "$key · model=${assistantProps.model} · maxTokens=${assistantProps.maxTokens} · 동시 상한 ${assistantProps.maxConcurrent}",
            "base=${assistantProps.baseUrl}",
        )
    }

    private fun execution(): List<String> {
        val s = execProps.ssrf
        val ssrf = if (!s.enabled) "⚠ OFF(전 대역 호출 허용)" else
            "ON(사설망 차단=${s.blockPrivateNetworks}, loopback 허용=${s.allowLoopback}, 스킴=${s.allowedSchemes}, 차단호스트 ${s.blockedHosts.size}건)"
        return listOf(
            "워커 풀 ${execProps.worker.poolSize} · 큐 ${execProps.worker.queueCapacity}(초과=429) · 실행당 노드 상한 ${execProps.maxNodesPerRun}",
            "HTTP connect ${execProps.http.connectTimeoutMs}ms / read ${execProps.http.readTimeoutMs}ms / 응답 상한 ${execProps.http.maxResponseBytes / 1024}KB",
            "SSRF 가드: $ssrf",
            "요청·응답 본문 캡처: " + if (execProps.capture.requestResponseBodies) "ON(로그에 본문 저장 — 디버그용)" else "OFF(deny-by-default)",
            "콜백(relay) base: " + (execProps.relay.configured?.let { "$it (env/yml 명시)" }
                ?: "미설정 → 화면 설정값 → 접속 오리진 자동 순으로 결정"),
        )
    }

    private fun transformsInfo(): List<String> {
        val all = transforms.list()
        val dir = env.getProperty("flowlink.plugins.dir") ?: "plugins"
        return listOf("등록 ${all.size}종 (플러그인 디렉터리=$dir) · ids=${all.map { it.id() }}")
    }

    private fun mocks(): List<String> {
        val repo = mockRepo.getIfAvailable() ?: return listOf("(조회 불가)")
        val all = repo.findAll()
        val enabled = all.count { it.isEnabled }
        val ports = tcpMocks.activePorts()
        val out = arrayListOf("서버 ${all.size}개(활성 $enabled) · 서빙 경로 /mock/{tenant}/{slug}/**")
        if (all.isNotEmpty()) {
            out += "slug: " + all.joinToString(", ") { "${it.slug}${if (it.isEnabled) "" else "(off)"}" }
        }
        out += "TCP 리스너: " + if (ports.isEmpty()) "없음" else ports.toString()
        return out
    }

    private fun triggers(): List<String> {
        val repo = triggerRepo.getIfAvailable() ?: return listOf("(조회 불가)")
        val all = repo.findAll()
        if (all.isEmpty()) return listOf("등록 없음(수동 실행만)")
        val sched = all.filter { it.type == TriggerType.SCHEDULE }
        val hook = all.filter { it.type == TriggerType.WEBHOOK }
        val out = arrayListOf("스케줄 ${sched.size}(활성 ${sched.count { it.enabled }}) · 웹훅 ${hook.size}(활성 ${hook.count { it.enabled }})")
        sched.filter { it.enabled }.take(10).forEach {
            out += "  ⏰ flow=${it.flowId} cron='${it.cron}' 다음실행=${it.nextRunAt ?: "-"}"
        }
        return out
    }

    private fun data(): List<String> {
        fun count(p: ObjectProvider<out org.springframework.data.repository.CrudRepository<*, *>>): String =
            try { p.getIfAvailable()?.count()?.toString() ?: "-" } catch (e: Exception) { "?" }
        return listOf(
            "플로우 ${count(flowRepo)} · 실행 이력 ${count(execRepo)} · 대기(재개 보류) ${count(suspensionRepo)} · DB 시크릿 ${count(secretRepo)}",
        )
    }

    private fun endpoints(): List<String> = listOf(
        "화면/API :${env.getProperty("local.server.port") ?: env.getProperty("server.port") ?: "18080"} · swagger ${env.getProperty("springdoc.swagger-ui.path") ?: "/swagger-ui.html"} · health /actuator/health",
        "콜백 수신 /relay/{execId}/cb/{nodeId} · 웹훅 /hooks/{token} · presence /ws/presence",
    )

    private fun uptimeSec(): String =
        String.format("%.1f", Duration.ofMillis(ManagementFactory.getRuntimeMXBean().uptime).toMillis() / 1000.0)

    /** JDBC URL 에 자격증명이 섞여 있으면 가린다(로그 유출 방지). */
    private fun maskUrl(url: String?): String {
        if (url.isNullOrBlank()) return "-"
        return url
            .replace(Regex("(?i)(password=)[^;&]*", RegexOption.IGNORE_CASE), "$1******")
            .replace(Regex("://([^:/@]+):([^@]+)@"), "://$1:******@")
    }

    companion object {
        private val log = LoggerFactory.getLogger(StartupSummaryLogger::class.java)

        /** 라벨 열의 표시 폭(전각 기준 칸 수). */
        private const val LABEL_COLS = 7
    }
}
