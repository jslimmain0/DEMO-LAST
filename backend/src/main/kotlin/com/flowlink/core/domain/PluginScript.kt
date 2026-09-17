package com.flowlink.core.domain

import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.Id
import jakarta.persistence.Index
import jakarta.persistence.Table
import org.hibernate.annotations.CreationTimestamp
import org.hibernate.annotations.UpdateTimestamp
import java.time.Instant
import java.util.UUID

/**
 * 스크립트 플러그인 — 화면에서 적은 JS 소스. `source` = 초안(편집 중), `liveSource` = 승인본(서빙 중).
 * 승인본은 새 초안이 승인될 때까지 계속 서빙된다(수정·반려가 운영에 무영향). status 는 초안의 상태.
 */
@Entity
@Table(name = "flowlink_plugin_script", indexes = [Index(name = "idx_plugin_script_tenant_pid", columnList = "tenant_id, plugin_id", unique = true)])
class PluginScript {
    @Id @Column(nullable = false, updatable = false) lateinit var id: UUID; private set
    @Column(name = "tenant_id", nullable = false, updatable = false) lateinit var tenantId: String; private set
    /** 스크립트 메타의 id — 레지스트리 키(그래프 transformId·Mock 코덱 step id·프로토콜 plugin.id 가 참조). */
    @Column(name = "plugin_id", nullable = false, length = 64) lateinit var pluginId: String
    @Column(nullable = false, length = 120) lateinit var name: String
    /** transform | fieldCodec | messageCodec — 컴파일 결과로 갱신(목록 표시용). */
    @Column(nullable = false, length = 20) lateinit var kind: String
    @Column(columnDefinition = "text", nullable = false) lateinit var source: String
    @Column(name = "live_source", columnDefinition = "text") var liveSource: String? = null
    @Column(nullable = false, length = 16) var status: String = STATUS_DRAFT
    /** 제출자가 마지막으로 돌린 샘플(입력·설정·출력·콘솔) JSON — 승인 화면에 첨부. */
    @Column(name = "sample_json", columnDefinition = "text") var sampleJson: String? = null
    @Column(name = "submitted_by", length = 180) var submittedBy: String? = null
    @Column(name = "submitted_at") var submittedAt: Instant? = null
    @Column(name = "reviewed_by", length = 180) var reviewedBy: String? = null
    @Column(name = "reviewed_at") var reviewedAt: Instant? = null
    @Column(name = "review_note", length = 1000) var reviewNote: String? = null
    @Column(name = "created_by", nullable = false, updatable = false, length = 180) lateinit var createdBy: String; private set
    @CreationTimestamp @Column(name = "created_at", nullable = false, updatable = false) lateinit var createdAt: Instant; private set
    @UpdateTimestamp @Column(name = "updated_at") var updatedAt: Instant? = null; private set

    companion object {
        const val STATUS_DRAFT = "DRAFT"; const val STATUS_PENDING = "PENDING"; const val STATUS_APPROVED = "APPROVED"; const val STATUS_REJECTED = "REJECTED"
        @JvmStatic fun create(tenantId: String, pluginId: String, name: String, kind: String, source: String, createdBy: String): PluginScript =
            PluginScript().also { it.id = UUID.randomUUID(); it.tenantId = tenantId; it.pluginId = pluginId; it.name = name; it.kind = kind; it.source = source; it.createdBy = createdBy }
    }
}
