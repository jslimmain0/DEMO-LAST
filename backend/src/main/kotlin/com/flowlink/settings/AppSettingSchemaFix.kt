package com.flowlink.settings

import org.slf4j.LoggerFactory
import org.springframework.boot.context.event.ApplicationReadyEvent
import org.springframework.context.event.EventListener
import org.springframework.stereotype.Component
import javax.sql.DataSource

/**
 * H2 dev 관용 — 기존 app_setting.setting_value 가 VARCHAR(255)로 만들어졌으면 CLOB 로 넓힌다.
 * (엔티티 columnDefinition="text" 는 신규 테이블에만 적용되고, ddl-auto:update 는 기존 컬럼 폭을 안 바꾼다.
 *  스킬 = 플로우 조각 JSON 은 255 를 넘으므로 필요.) Flyway DB(PG/Oracle)는 이미 text/clob → 실행 안 함.
 */
@Component
class AppSettingSchemaFix(private val dataSource: DataSource) {

    private val log = LoggerFactory.getLogger(AppSettingSchemaFix::class.java)

    @EventListener(ApplicationReadyEvent::class)
    fun widenIfH2() {
        try {
            dataSource.connection.use { c ->
                val product = c.metaData.databaseProductName ?: ""
                if (!product.contains("H2", ignoreCase = true)) return
                c.createStatement().use { it.execute("ALTER TABLE app_setting ALTER COLUMN setting_value SET DATA TYPE CLOB") }
                log.info("app_setting.setting_value 를 CLOB 로 확장(H2 dev)")
            }
        } catch (e: Exception) {
            // 이미 넓거나 테이블 없음 — 무해
            log.debug("app_setting 컬럼 확장 생략: {}", e.message)
        }
    }
}
