package com.flowlink.secret

import com.flowlink.common.crypto.CryptoProvider
import com.flowlink.common.crypto.RoutingCrypto
import com.flowlink.core.domain.Secret
import com.flowlink.core.repository.SecretRepository
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.autoconfigure.jdbc.AutoConfigureTestDatabase
import org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest
import org.springframework.boot.test.autoconfigure.orm.jpa.TestEntityManager
import org.springframework.test.context.TestPropertySource

/**
 * Transit 전환 기동 시 레거시(비 vault: 형식) 시크릿 행을 일괄 재암호화 — 이후 env 의
 * FLOWLINK_EXECUTION_STATE_SECRET 을 제거해도 모든 행이 KEK 로 열린다.
 */
@DataJpaTest
@AutoConfigureTestDatabase(replace = AutoConfigureTestDatabase.Replace.NONE)
@TestPropertySource(properties = [
    "spring.datasource.url=jdbc:h2:mem:reenctest;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE",
    "spring.datasource.driver-class-name=org.h2.Driver",
    "spring.datasource.username=sa",
    "spring.datasource.password=",
    "spring.flyway.enabled=false",
    "spring.jpa.hibernate.ddl-auto=create-drop",
])
class SecretReencryptMigrationTest {

    @Autowired lateinit var repo: SecretRepository
    @Autowired lateinit var em: TestEntityManager

    /** 가역 가짜 프로바이더 — prefix 를 붙였다 뗀다. */
    private class Fake(val tag: String) : CryptoProvider {
        override fun encrypt(plain: String): String = "$tag:$plain"
        override fun decrypt(encoded: String): String = encoded.removePrefix("$tag:")
    }

    private fun service(crypto: CryptoProvider) =
        SecretService(repo, VaultSecretSource(VaultProperties()), crypto)

    @Test
    fun `RoutingCrypto 면 레거시 행만 Transit 형식으로 재암호화한다`() {
        em.persist(Secret.create("t1", "apiKey", "legacy:one", Secret.COMMON))
        em.persist(Secret.create("t1", "dbPass", "legacy:two", "prod"))
        em.persist(Secret.create("t2", "already", "vault:v1:three", Secret.COMMON))
        em.flush(); em.clear()

        val crypto = RoutingCrypto(Fake("vault:v1"), Fake("legacy"))
        service(crypto).reencryptLegacyOnStartup()
        em.flush(); em.clear() // 수동 생성 서비스라 프록시 tx 가 없음 — 테스트 tx 에서 dirty 변경을 flush

        val rows = repo.findAll().associateBy { it.name }
        assertThat(rows.values).allMatch { it.encValue.startsWith("vault:v1:") }
        // 원문 보존 — 라우팅 복호화로 원래 값이 그대로 나온다
        assertThat(crypto.decrypt(rows["apiKey"]!!.encValue)).isEqualTo("one")
        assertThat(crypto.decrypt(rows["dbPass"]!!.encValue)).isEqualTo("two")
        assertThat(crypto.decrypt(rows["already"]!!.encValue)).isEqualTo("three")
    }

    @Test
    fun `RoutingCrypto 가 아니면(로컬 모드) 아무것도 바꾸지 않는다`() {
        em.persist(Secret.create("t1", "apiKey", "legacy:one", Secret.COMMON))
        em.flush(); em.clear()

        service(Fake("legacy")).reencryptLegacyOnStartup()
        em.flush(); em.clear()

        assertThat(repo.findAll().single().encValue).isEqualTo("legacy:one")
    }
}
