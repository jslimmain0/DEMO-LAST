package com.flowlink.core.repository

import com.flowlink.core.domain.MockServerVersion
import org.springframework.data.jpa.repository.JpaRepository
import org.springframework.data.jpa.repository.Modifying
import org.springframework.data.jpa.repository.Query
import org.springframework.data.repository.query.Param
import java.util.Optional
import java.util.UUID

interface MockServerVersionRepository : JpaRepository<MockServerVersion, UUID> {

    fun findByMockServerIdOrderByVersionNoDesc(mockServerId: UUID): List<MockServerVersion>

    fun findByMockServerIdAndVersionNo(mockServerId: UUID, versionNo: Int): Optional<MockServerVersion>

    fun findTopByMockServerIdOrderByVersionNoDesc(mockServerId: UUID): Optional<MockServerVersion>

    /** 정리 대상 — 📌 보존 아닌 것 중 [keepFrom] 미만 버전(최근 N개 유지). */
    @Query("SELECT v FROM MockServerVersion v WHERE v.mockServerId = :mockId AND v.versionNo < :keepFrom AND (v.pinned IS NULL OR v.pinned = false)")
    fun findPrunable(@Param("mockId") mockId: UUID, @Param("keepFrom") keepFrom: Int): List<MockServerVersion>

    @Modifying
    @Query("DELETE FROM MockServerVersion v WHERE v.mockServerId = :mockId")
    fun deleteByMockServerId(@Param("mockId") mockId: UUID): Int
}
