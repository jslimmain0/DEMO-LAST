package com.flowlink.secret

import com.flowlink.common.crypto.CryptoProvider
import com.flowlink.common.crypto.RoutingCrypto
import com.flowlink.common.error.BadRequestException
import com.flowlink.common.error.NotFoundException
import com.flowlink.common.tenant.TenantContext
import com.flowlink.core.domain.Secret
import com.flowlink.core.repository.SecretRepository
import org.slf4j.LoggerFactory
import org.springframework.boot.context.event.ApplicationReadyEvent
import org.springframework.context.event.EventListener
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Instant

/**
 * 시크릿 볼트 — 값은 [CryptoProvider](로컬 AES-GCM 또는 Vault Transit KEK)로 암호화 저장.
 * API 는 write-only(이름만 조회). 실행 시 [activeSecrets] 로 복호화해 `{{ 이름@secret }}` 스코프에
 * 시드하고, 캡처 로그는 NodeRecorder 가 마스킹한다.
 */
@Service
class SecretService(
    private val repo: SecretRepository,
    private val crypto: CryptoProvider,
) {

    // environment: null=공통(COMMON). 화면엔 공통을 null 로 보여준다.
    data class SecretView(val name: String, val environment: String?, val createdAt: Instant?)

    /** 기동 시 레거시 NULL environment 행을 공통('*')으로 백필(H2 dev 관용, Flyway DB 는 0건). */
    @EventListener(ApplicationReadyEvent::class)
    @Transactional
    fun backfillEnvironmentOnStartup() {
        try { repo.backfillNullEnvironment(Secret.COMMON) } catch (e: Exception) { /* 백필 실패는 무해 — 무시 */ }
    }

    /**
     * Transit(KEK) 전환 기동 시 레거시(비 `vault:` 형식) 행을 일괄 재암호화 — 한 번 부팅하면
     * 모든 시크릿이 KEK 로 열려 이후 `FLOWLINK_EXECUTION_STATE_SECRET` env 를 제거할 수 있다.
     * 실패는 예외로 전파해 기동을 막는다(반쯤 이관된 채 조용히 뜨는 것 방지).
     */
    @EventListener(ApplicationReadyEvent::class)
    @Transactional
    fun reencryptLegacyOnStartup() {
        if (crypto !is RoutingCrypto) return
        var migrated = 0
        for (s in repo.findAll()) {
            if (!RoutingCrypto.isTransitFormat(s.encValue)) {
                s.encValue = crypto.encrypt(crypto.decrypt(s.encValue))
                migrated++
            }
        }
        if (migrated > 0) log.info("시크릿 {}건을 Vault Transit(KEK) 형식으로 재암호화", migrated)
    }

    fun listNames(): List<SecretView> = repo.findByTenantIdOrderByEnvironmentAscNameAsc(tenant())
        .map { SecretView(it.name, viewEnv(it.environment), it.createdAt) }

    @Transactional
    fun put(name: String, value: String, environment: String?) {
        val n = name.trim()
        if (!NAME.matches(n)) throw BadRequestException("시크릿 이름은 영문/숫자/._- 만 허용합니다.")
        if (value.isEmpty()) throw BadRequestException("시크릿 값이 비어 있습니다.")
        val env = normalizeEnv(environment)
        val enc = crypto.encrypt(value)
        val existing = repo.findByTenantIdAndEnvironmentAndName(tenant(), env, n).orElse(null)
        if (existing == null) repo.save(Secret.create(tenant(), n, enc, env))
        else existing.encValue = enc
    }

    @Transactional
    fun delete(name: String, environment: String?) {
        val env = normalizeEnv(environment)
        val s = repo.findByTenantIdAndEnvironmentAndName(tenant(), env, name.trim())
            .orElseThrow { NotFoundException.of("Secret", "$name@$env") }
        repo.delete(s)
    }

    /**
     * 실행 시 복호화 머지 맵 — 공통(common) 위에 활성 환경(envName)을 이름 단위로 오버레이. 시드 + 마스킹 소스.
     * envName 미정의/미전송이면 공통만. 다른 환경 전용 시크릿은 복호화조차 안 함.
     */
    fun activeSecrets(envName: String?): Map<String, String> {
        val env = envName?.trim().orEmpty()
        val commonRows = ArrayList<Secret>()
        val scopedRows = ArrayList<Secret>()
        for (s in repo.findByTenantIdOrderByEnvironmentAscNameAsc(tenant())) {
            val e = s.environment
            when {
                e.isNullOrEmpty() || e == Secret.COMMON -> commonRows.add(s)
                env.isNotEmpty() && e == env -> scopedRows.add(s)
            }
        }
        // 복호화는 한 번에(decryptAll) — Transit 모드에선 실행당 Vault 왕복 1회(batch)로 묶인다.
        val rows = commonRows + scopedRows
        val plains = crypto.decryptAll(rows.map { it.encValue })
        // 우선순위(높을수록 승): 활성 환경 > 공통. rows 가 공통 → 활성환경 순이라 같은 이름은 환경값이 덮는다.
        return rows.mapIndexed { i, s -> s.name to plains[i] }.toMap()
    }

    private fun viewEnv(e: String?): String? = if (e.isNullOrEmpty() || e == Secret.COMMON) null else e
    private fun normalizeEnv(e: String?): String = e?.trim().takeUnless { it.isNullOrEmpty() } ?: Secret.COMMON

    private fun tenant(): String = TenantContext.getTenantId()

    companion object {
        private val log = LoggerFactory.getLogger(SecretService::class.java)
        private val NAME = Regex("^[\\w.-]+$")
    }
}
