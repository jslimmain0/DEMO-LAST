package com.flowlink.core.domain

import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.Id
import jakarta.persistence.Table
import org.hibernate.annotations.CreationTimestamp
import java.time.Instant
import java.util.Objects
import java.util.UUID

/**
 * 워크플로 정의의 불변 스냅샷(버전). 저장/실행의 진실 원본은 [graphJson] 이며,
 * 원시 JSON 문자열로 보관해 프로토타입 export 포맷과 무손실 라운드트립한다(Phase 2에서 jsonb 전환).
 *
 * 불변이므로 수정 대신 항상 새 버전을 만든다 → 실행 재현성/롤백/감사에 유리.
 */
@Entity
@Table(name = "flow_version")
class FlowVersion {

    @Id
    @Column(nullable = false, updatable = false)
    lateinit var id: UUID
        private set

    @Column(name = "flow_id", nullable = false, updatable = false)
    lateinit var flowId: UUID
        private set

    @Column(name = "version_no", nullable = false, updatable = false)
    var versionNo: Int = 0
        private set

    @Column(nullable = false)
    lateinit var name: String
        private set

    // Phase 1: text 컬럼에 원시 JSON 문자열 저장(확실한 라운드트립).
    // Phase 2: jsonb + 전용 타입핸들러(hypersistence-utils 등)로 전환해 경로 질의/인덱싱 확보.
    @Column(name = "graph_json", columnDefinition = "text", nullable = false)
    lateinit var graphJson: String
        private set

    @Column(columnDefinition = "text")
    var note: String? = null
        private set

    @Column(name = "created_by")
    var createdBy: String? = null
        private set

    /**
     * 📌 보존 버전(커밋) — 사용자가 메시지를 붙여 명시적으로 남긴 스냅샷.
     * 자동 보존 정책(retention)의 버전 정리에서 **절대 삭제되지 않는다**.
     * null=false(레거시 행 — H2 ddl-auto 호환), 토글 가능(불변 스냅샷 규약의 유일한 가변 필드).
     */
    @Column
    var pinned: Boolean? = null

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    lateinit var createdAt: Instant
        private set

    companion object {
        @JvmStatic
        fun create(
            flowId: UUID, versionNo: Int, name: String,
            graphJson: String, note: String?, createdBy: String?
        ): FlowVersion {
            val v = FlowVersion()
            v.id = UUID.randomUUID()
            v.flowId = flowId
            v.versionNo = versionNo
            v.name = name
            v.graphJson = graphJson
            v.note = note
            v.createdBy = createdBy
            return v
        }
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) {
            return true
        }
        if (other !is FlowVersion) {
            return false
        }
        if (!this::id.isInitialized || !other::id.isInitialized) {
            return false
        }
        return id == other.id
    }

    override fun hashCode(): Int = Objects.hashCode(if (this::id.isInitialized) id else null)
}
