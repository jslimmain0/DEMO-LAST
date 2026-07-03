package com.flowlink.core.repository;

import com.flowlink.core.domain.MockServer;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface MockServerRepository extends JpaRepository<MockServer, UUID> {

    List<MockServer> findByTenantIdOrderByUpdatedAtDesc(String tenantId);

    Optional<MockServer> findByIdAndTenantId(UUID id, String tenantId);

    /** 서빙 경로 조회 — slug 는 전역 유니크라 테넌트 무관(무인증 게이트웨이용). */
    Optional<MockServer> findBySlug(String slug);

    boolean existsBySlug(String slug);
}
