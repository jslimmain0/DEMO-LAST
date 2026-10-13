package com.flowlink.secret

import com.flowlink.common.crypto.CryptoProvider
import com.flowlink.common.crypto.RoutingCrypto
import com.flowlink.common.error.BadRequestException
import com.flowlink.common.tenant.TenantContext
import com.flowlink.core.domain.Secret
import com.flowlink.core.repository.SecretRepository
import com.flowlink.execution.engine.StateCrypto
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.autoconfigure.jdbc.AutoConfigureTestDatabase
import org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest
import org.springframework.boot.test.autoconfigure.orm.jpa.TestEntityManager
import org.springframework.test.context.TestPropertySource

@DataJpaTest
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@TestPropertySource(properties = [
    "spring.datasource.url=jdbc:h2:mem:secretregistration;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE",
    "spring.datasource.driver-class-name=org.h2.Driver",
    "spring.datasource.username=sa",
    "spring.datasource.password=",
    "spring.jpa.hibernate.ddl-auto=create-drop",
])
class SecretCiphertextRegistrationTest {
    @Autowired lateinit var repo: SecretRepository
    @Autowired lateinit var em: TestEntityManager

    private class FakeCrypto(private val prefix: String) : CryptoProvider {
        val encrypted = mutableListOf<String>()
        override fun encrypt(plain: String): String {
            encrypted.add(plain)
            return "$prefix:$plain"
        }
        override fun decrypt(encoded: String): String = encoded.removePrefix("$prefix:")
    }

    @Test
    fun `Vault ciphertext is persisted unchanged and resolves to plaintext during execution`() {
        val transit = FakeCrypto("vault:v1")
        val service = SecretService(repo, RoutingCrypto(transit, FakeCrypto("legacy")))
        val ciphertext = "vault:v1:external-secret"
        service.put("API_TOKEN", ciphertext, null)
        service.put("PASSWORD", "plain-secret", "prod")
        em.flush(); em.clear()

        val rows = repo.findAll().associateBy { it.name }
        assertThat(rows.getValue("API_TOKEN").encValue).isEqualTo(ciphertext)
        assertThat(transit.encrypted).containsExactly("plain-secret")
        assertThat(service.activeSecrets("prod")).containsEntry("API_TOKEN", "external-secret").containsEntry("PASSWORD", "plain-secret")
        assertThat(service.listNames().map { it.name }).containsExactlyInAnyOrder("API_TOKEN", "PASSWORD")
    }

    @Test
    fun `replacement retains secret identity and environment while storing ciphertext unchanged`() {
        val crypto = FakeCrypto("legacy")
        val original = Secret.create(TenantContext.getTenantId(), "API_TOKEN", "legacy:old", "prod")
        em.persistAndFlush(original)
        val id = original.id
        val service = SecretService(repo, crypto)
        service.put("API_TOKEN", "vault:v2:replacement", "prod")
        em.flush(); em.clear()

        val stored = repo.findAll().single()
        assertThat(stored.id).isEqualTo(id)
        assertThat(stored.environment).isEqualTo("prod")
        assertThat(stored.encValue).isEqualTo("vault:v2:replacement")
        assertThat(crypto.encrypted).isEmpty()
    }

    @Test
    fun `disabled Transit rejects ciphertext without inserting or replacing a usable secret`() {
        val service = SecretService(repo, StateCrypto("synthetic-storage-key"))
        service.put("TOKEN", "원문은 Base64가 아니어도 됩니다!", null)
        em.flush(); em.clear()
        val before = repo.findAll().single().encValue

        for (name in listOf("TOKEN", "NEW_TOKEN")) {
            assertThatThrownBy { service.put(name, "vault:v1:synthetic-ciphertext", null) }
                .isInstanceOf(BadRequestException::class.java)
                .hasMessageContaining("Vault Transit")
                .hasMessageNotContaining("synthetic-ciphertext")
        }
        em.flush(); em.clear()
        assertThat(repo.findAll()).hasSize(1)
        assertThat(repo.findAll().single().encValue).isEqualTo(before)
        assertThat(service.activeSecrets(null)).containsEntry("TOKEN", "원문은 Base64가 아니어도 됩니다!")
    }

    @Test
    fun `ordinary values remain encrypted without trimming or case normalization`() {
        val crypto = FakeCrypto("legacy")
        val service = SecretService(repo, crypto)
        service.put("SPACED", " vault:v1:text ", null)
        service.put("UPPERCASE", "VAULT:v1:text", null)
        em.flush(); em.clear()

        assertThat(crypto.encrypted).containsExactly(" vault:v1:text ", "VAULT:v1:text")
        assertThat(service.activeSecrets(null)).containsEntry("SPACED", " vault:v1:text ").containsEntry("UPPERCASE", "VAULT:v1:text")
    }
}
