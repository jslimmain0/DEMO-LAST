package com.flowlink.settings

import com.flowlink.common.tenant.TenantContext
import com.flowlink.core.domain.AppSetting
import com.flowlink.core.repository.AppSettingRepository
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional

/** 화면에서 저장/수정하는 런타임 설정(키-값, 테넌트 스코프). */
@Service
class SettingsService(private val repo: AppSettingRepository) {

    @Transactional(readOnly = true)
    fun get(key: String): String? =
        repo.findByTenantIdAndKey(TenantContext.getTenantId(), key)
            .map { it.value }
            .orElse(null)

    /** 저장(빈 값/공백이면 삭제 = 자동으로 되돌리기). */
    @Transactional
    fun put(key: String, value: String?) {
        val tenant = TenantContext.getTenantId()
        val existing = repo.findByTenantIdAndKey(tenant, key).orElse(null)
        if (value.isNullOrBlank()) {
            if (existing != null) {
                repo.delete(existing)
            }
            return
        }
        if (existing == null) {
            repo.save(AppSetting.create(tenant, key, value.trim()))
        } else {
            existing.value = value.trim()
        }
    }

    /** wait 콜백 수신 base URL — 화면에서 저장한 값(없으면 null). */
    @Transactional(readOnly = true)
    fun relayBaseUrl(): String? = get(KEY_RELAY_BASE)

    /** 실행 실패 알림 웹훅 URL(Slack/Teams incoming webhook 등) — 없으면 null. */
    @Transactional(readOnly = true)
    fun notifyWebhookUrl(): String? = get(KEY_NOTIFY_WEBHOOK)

    companion object {
        const val KEY_RELAY_BASE = "relay.base-url"
        const val KEY_NOTIFY_WEBHOOK = "notify.webhook-url"
    }
}
