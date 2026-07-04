package com.flowlink.core.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;

import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

/**
 * Mock 서버 — 워크플로가 호출할 가짜 대상 시스템을 사용자가 정의·서빙하는 1급 리소스.
 * 저장하면 즉시 {@code /mock/{slug}/**} 로 서빙된다(별도 프로세스 없음).
 *
 * <p>라우트/규칙/응답 템플릿을 spec_json 으로 정의한다(전부 사용자 정의 커스텀 목).
 * slug 는 서빙 URL 경로라서 <b>전역 유니크</b>(테넌트 무관). 서빙은 무인증(외부 시스템 흉내),
 * 관리 API 만 테넌트 스코프.
 *
 * <p>{@code kind} 는 향후 프리셋 확장 여지를 위해 남긴 컬럼으로, 현재는 CUSTOM 하나뿐이다.
 */
@Entity
@Table(name = "mock_server")
public class MockServer {

    public enum Kind { CUSTOM }

    @Id
    @Column(nullable = false, updatable = false)
    private UUID id;

    @Column(name = "tenant_id", nullable = false)
    private String tenantId;

    @Column(nullable = false)
    private String name;

    /** 서빙 경로 조각(/mock/{slug}/…) — 전역 유니크, [a-z0-9-]{3,40}. */
    @Column(nullable = false, unique = true, length = 64)
    private String slug;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 16)
    private Kind kind;

    @Column(nullable = false)
    private boolean enabled;

    /** CUSTOM: { routes: [...] } · PG: { secret?: "..." } */
    @Column(name = "spec_json", columnDefinition = "text")
    private String specJson;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected MockServer() {
    }

    public static MockServer create(String tenantId, String name, String slug, Kind kind, String specJson) {
        MockServer m = new MockServer();
        m.id = UUID.randomUUID();
        m.tenantId = tenantId;
        m.name = name;
        m.slug = slug;
        m.kind = kind;
        m.enabled = true;
        m.specJson = specJson;
        return m;
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

    public String getSlug() {
        return slug;
    }

    public Kind getKind() {
        return kind;
    }

    public boolean isEnabled() {
        return enabled;
    }

    public void setEnabled(boolean enabled) {
        this.enabled = enabled;
    }

    public String getSpecJson() {
        return specJson;
    }

    public void setSpecJson(String specJson) {
        this.specJson = specJson;
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
        return o instanceof MockServer other && id != null && id.equals(other.id);
    }

    @Override
    public int hashCode() {
        return Objects.hashCode(id);
    }
}
