package com.flowlink.core.domain

import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.Id
import jakarta.persistence.Index
import jakarta.persistence.Table
import jakarta.persistence.UniqueConstraint
import org.hibernate.annotations.CreationTimestamp
import java.time.Instant
import java.util.UUID

/**
 * Mock 서버 정의(spec_json)의 불변 스냅샷 — 워크플로 FlowVersion 의 Mock 판. 저장(updateSpec)마다 내용이 바뀌었으면 1개 쌓이고,
 * 복원은 과거 스냅샷을 **새 버전으로** 다시 쌓는다(이력 보존). 📌 pinned 는 자동 정리(mock 당 최근 N개 유지)에서 제외.
 */
@Entity
@Table(
    name = "flowlink_mock_server_version",
    uniqueConstraints = [UniqueConstraint(name = "uq_mock_server_version", columnNames = ["mock_server_id", "version_no"])],
    indexes = [Index(name = "idx_mock_server_version_mock", columnList = "mock_server_id")],
)
class MockServerVersion {

    @Id
    @Column(nullable = false, updatable = false)
    lateinit var id: UUID
        private set

    @Column(name = "mock_server_id", nullable = false, updatable = false)
    lateinit var mockServerId: UUID
        private set

    @Column(name = "version_no", nullable = false, updatable = false)
    var versionNo: Int = 0
        private set

    @Column(name = "spec_json", columnDefinition = "text", nullable = false)
    lateinit var specJson: String
        private set

    @Column(columnDefinition = "text")
    var note: String? = null

    @Column(name = "created_by")
    var createdBy: String? = null

    /** 📌 보존 — null=false(레거시/H2 ddl-auto 관례). */
    @Column(name = "pinned")
    var pinned: Boolean? = null

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    lateinit var createdAt: Instant
        private set

    companion object {
        @JvmStatic
        fun create(mockServerId: UUID, versionNo: Int, specJson: String, note: String?, createdBy: String?): MockServerVersion {
            val v = MockServerVersion()
            v.id = UUID.randomUUID()
            v.mockServerId = mockServerId
            v.versionNo = versionNo
            v.specJson = specJson
            v.note = note
            v.createdBy = createdBy
            return v
        }
    }
}
