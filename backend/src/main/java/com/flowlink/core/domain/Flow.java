package com.flowlink.core.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;

import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

/**
 * 워크플로(논리적 컨테이너). 실제 그래프 내용은 불변 {@link FlowVersion} 들에 보관되고,
 * Flow 는 메타데이터와 "현재 버전 포인터"를 갖는다. (버전관리/롤백의 기반)
 */
@Entity
@Table(name = "flow")
public class Flow {

    @Id
    @Column(nullable = false, updatable = false)
    private UUID id;

    @Column(name = "tenant_id", nullable = false)
    private String tenantId;

    @Column(nullable = false)
    private String name;

    @Column(columnDefinition = "text")
    private String description;

    /** 현재 활성 버전 번호(없으면 0). */
    @Column(name = "current_version", nullable = false)
    private int currentVersion;

    @Column(nullable = false)
    private boolean archived;

    /** 낙관적 잠금 — 동시 편집 lost-update 방지(저장 충돌 시 409로 매핑). */
    @Version
    @Column(nullable = false)
    private long version;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected Flow() {
    }

    public static Flow create(String tenantId, String name, String description) {
        Flow f = new Flow();
        f.id = UUID.randomUUID();
        f.tenantId = tenantId;
        f.name = name;
        f.description = description;
        f.currentVersion = 0;
        f.archived = false;
        return f;
    }

    public UUID getId() {
        return id;
    }

    public String getTenantId() {
        return tenantId;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public String getDescription() {
        return description;
    }

    public void setDescription(String description) {
        this.description = description;
    }

    public int getCurrentVersion() {
        return currentVersion;
    }

    public void setCurrentVersion(int currentVersion) {
        this.currentVersion = currentVersion;
    }

    public boolean isArchived() {
        return archived;
    }

    public void setArchived(boolean archived) {
        this.archived = archived;
    }

    public long getVersion() {
        return version;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getUpdatedAt() {
        return updatedAt;
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) {
            return true;
        }
        return o instanceof Flow other && id != null && id.equals(other.id);
    }

    @Override
    public int hashCode() {
        return Objects.hashCode(id);
    }
}
