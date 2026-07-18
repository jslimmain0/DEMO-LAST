package com.flowlink.secret

import com.flowlink.common.error.BadRequestException
import com.flowlink.common.error.NotFoundException
import com.flowlink.common.tenant.TenantContext
import com.flowlink.core.domain.Secret
import com.flowlink.core.repository.SecretRepository
import com.flowlink.execution.config.ExecutionProperties
import com.flowlink.execution.engine.StateCrypto
import org.springframework.boot.context.event.ApplicationReadyEvent
import org.springframework.context.event.EventListener
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Instant

/**
 * 시크릿 볼트 — 값은 AES-GCM(StateCrypto)으로 암호화 저장. API 는 write-only(이름만 조회).
 * 실행 시 [activeSecrets] 로 복호화해 `{{ 이름@secret }}` 스코프에 시드하고, 캡처 로그는 NodeRecorder 가 마스킹한다.
 */
@Service
class SecretService(
    private val repo: SecretRepository,
    props: ExecutionProperties,
) {
    private val crypto = StateCrypto(props.stateSecret)

    // environment: null=공통(COMMON). 화면엔 공통을 null 로 보여준다.
    data class SecretView(val name: String, val environment: String?, val createdAt: Instant)

    /** 기동 시 레거시 NULL environment 행을 공통('*')으로 백필(H2 dev 관용, Flyway DB 는 0건). */
    @EventListener(ApplicationReadyEvent::class)
    @Transactional
    fun backfillEnvironmentOnStartup() {
        try { repo.backfillNullEnvironment(Secret.COMMON) } catch (e: Exception) { /* 백필 실패는 무해 — 무시 */ }
    }

    @Transactional(readOnly = true)
    fun listNames(): List<SecretView> =
        repo.findByTenantIdOrderByEnvironmentAscNameAsc(tenant()).map { SecretView(it.name, viewEnv(it.environment), it.createdAt) }

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
    @Transactional(readOnly = true)
    fun activeSecrets(envName: String?): Map<String, String> {
        val env = envName?.trim().orEmpty()
        val common = LinkedHashMap<String, String>()
        val scoped = LinkedHashMap<String, String>()
        for (s in repo.findByTenantIdOrderByEnvironmentAscNameAsc(tenant())) {
            val e = s.environment
            when {
                e.isNullOrEmpty() || e == Secret.COMMON -> common[s.name] = crypto.decrypt(s.encValue)
                env.isNotEmpty() && e == env -> scoped[s.name] = crypto.decrypt(s.encValue)
            }
        }
        return LinkedHashMap(common).apply { putAll(scoped) }
    }

    private fun viewEnv(e: String?): String? = if (e.isNullOrEmpty() || e == Secret.COMMON) null else e
    private fun normalizeEnv(e: String?): String = e?.trim().takeUnless { it.isNullOrEmpty() } ?: Secret.COMMON

    private fun tenant(): String = TenantContext.getTenantId()

    companion object {
        private val NAME = Regex("^[\\w.-]+$")
    }
}
