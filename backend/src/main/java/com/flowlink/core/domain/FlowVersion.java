package com.flowlink.core.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import org.hibernate.annotations.CreationTimestamp;

import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

/**
 * 워크플로 정의의 불변 스냅샷(버전). 저장/실행의 진실 원본은 {@link #graphJson} 이며,
 * 원시 JSON 문자열로 보관해 프로토타입 export 포맷과 무손실 라운드트립한다(Phase 2에서 jsonb 전환).
 *
 * <p>불변이므로 수정 대신 항상 새 버전을 만든다 → 실행 재현성/롤백/감사에 유리.
 */
@Entity
@Table(name = "flow_version")
public class FlowVersion {

    @Id
    @Column(nullable = false, updatable = false)
    private UUID id;

    @Column(name = "flow_id", nullable = false, updatable = false)
    private UUID flowId;

    @Column(name = "version_no", nullable = false, updatable = false)
    private int versionNo;

    @Column(nullable = false)
    private String name;

    // Phase 1: text 컬럼에 원시 JSON 문자열 저장(확실한 라운드트립).
    // Phase 2: jsonb + 전용 타입핸들러(hypersistence-utils 등)로 전환해 경로 질의/인덱싱 확보.
    @Column(name = "graph_json", columnDefinition = "text", nullable = false)
    private String graphJson;

    @Column(columnDefinition = "text")
    private String note;

    @Column(name = "created_by")
    private String createdBy;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    protected FlowVersion() {
    }

    public static FlowVersion create(UUID flowId, int versionNo, String name,
                                     String graphJson, String note, String createdBy) {
        FlowVersion v = new FlowVersion();
        v.id = UUID.randomUUID();
        v.flowId = flowId;
        v.versionNo = versionNo;
        v.name = name;
        v.graphJson = graphJson;
        v.note = note;
        v.createdBy = createdBy;
        return v;
    }

    public UUID getId() {
        return id;
    }

    public UUID getFlowId() {
        return flowId;
    }

    public int getVersionNo() {
        return versionNo;
    }

    public String getName() {
        return name;
    }

    public String getGraphJson() {
        return graphJson;
    }

    public String getNote() {
        return note;
    }

    public String getCreatedBy() {
        return createdBy;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) {
            return true;
        }
        return o instanceof FlowVersion other && id != null && id.equals(other.id);
    }

    @Override
    public int hashCode() {
        return Objects.hashCode(id);
    }
}
