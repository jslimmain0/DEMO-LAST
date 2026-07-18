package com.flowlink.mock

import org.slf4j.LoggerFactory
import org.springframework.boot.context.event.ApplicationReadyEvent
import org.springframework.context.event.EventListener
import org.springframework.stereotype.Component
import javax.sql.DataSource

/**
 * H2 dev 관용 — mock_server.kind 는 @Enumerated(STRING) 이라 Hibernate 가 `CHECK (kind IN ('CUSTOM'))` 제약을 걸어뒀는데,
 * enum 을 CUSTOM→CUSTOM/HTTP/TCP 로 확장해도 ddl-auto:update 는 기존 CHECK 제약을 못 바꾼다. 그래서 HTTP/TCP 저장이
 * "Value not permitted" 로 터진다. 옛 제약(CUSTOM 만 허용, HTTP 미포함)을 기동 시 드롭한다.
 * (Kotlin enum 이 값 유효성을 이미 보장 — DB CHECK 는 중복 방어일 뿐.) Flyway DB(PG/Oracle)는 varchar 라 무해·무영향.
 */
@Component
class MockServerSchemaFix(private val dataSource: DataSource) {

    private val log = LoggerFactory.getLogger(MockServerSchemaFix::class.java)

    @EventListener(ApplicationReadyEvent::class)
    fun relaxKindCheckIfH2() {
        try {
            dataSource.connection.use { c ->
                if (!(c.metaData.databaseProductName ?: "").contains("H2", ignoreCase = true)) return
                // H2 는 @Enumerated 컬럼을 native ENUM('CUSTOM') 타입으로 만든다 — ddl-auto:update 가 값 확장을 못 해
                // HTTP/TCP 저장이 터진다. kind 를 평범한 VARCHAR 로 바꿔 제한을 없앤다(@Enumerated STRING 은 VARCHAR 로 정상 동작).
                c.createStatement().use { it.execute("ALTER TABLE mock_server ALTER COLUMN kind SET DATA TYPE VARCHAR(16)") }
                log.info("mock_server.kind 를 VARCHAR 로 전환(H2 dev — enum 값 제한 완화)")
            }
        } catch (e: Exception) {
            log.debug("mock kind 제약 완화 생략: {}", e.message)
        }
    }
}
