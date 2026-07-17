package com.flowlink.secret

import com.flowlink.common.error.BadRequestException
import com.flowlink.common.error.NotFoundException
import com.flowlink.common.tenant.TenantContext
import com.flowlink.core.domain.Secret
import com.flowlink.core.repository.SecretRepository
import com.flowlink.execution.config.ExecutionProperties
import com.flowlink.execution.engine.StateCrypto
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

    data class SecretView(val name: String, val createdAt: Instant)

    @Transactional(readOnly = true)
    fun listNames(): List<SecretView> =
        repo.findByTenantIdOrderByName(tenant()).map { SecretView(it.name, it.createdAt) }

    @Transactional
    fun put(name: String, value: String) {
        val n = name.trim()
        if (!NAME.matches(n)) throw BadRequestException("시크릿 이름은 영문/숫자/._- 만 허용합니다.")
        if (value.isEmpty()) throw BadRequestException("시크릿 값이 비어 있습니다.")
        val enc = crypto.encrypt(value)
        val existing = repo.findByTenantIdAndName(tenant(), n).orElse(null)
        if (existing == null) repo.save(Secret.create(tenant(), n, enc))
        else existing.encValue = enc
    }

    @Transactional
    fun delete(name: String) {
        val s = repo.findByTenantIdAndName(tenant(), name.trim())
            .orElseThrow { NotFoundException.of("Secret", name) }
        repo.delete(s)
    }

    /** 실행 시 복호화한 이름→값 맵(테넌트 전체). 시드 + 마스킹 소스. */
    @Transactional(readOnly = true)
    fun activeSecrets(): Map<String, String> =
        repo.findByTenantIdOrderByName(tenant()).associate { it.name to crypto.decrypt(it.encValue) }

    private fun tenant(): String = TenantContext.getTenantId()

    companion object {
        private val NAME = Regex("^[\\w.-]+$")
    }
}
