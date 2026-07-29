package com.flowlink.security

import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.test.context.TestPropertySource
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status

/**
 * github 게스트 모드 보안 경계 — 앱은 로그인 없이 개방되고 assistant API(/api/v1/assistant 이하)만 로그인 필수.
 * (스키마: H2 인메모리 + create-drop, Flyway off — ExecutionSuspensionRepositoryTest 와 동일 관례.)
 */
@SpringBootTest
@AutoConfigureMockMvc
@TestPropertySource(properties = [
    "spring.datasource.url=jdbc:h2:mem:guestmode;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE",
    "spring.datasource.driver-class-name=org.h2.Driver",
    "spring.datasource.username=sa",
    "spring.datasource.password=",
    "spring.flyway.enabled=false",
    "spring.jpa.hibernate.ddl-auto=create-drop",
    "flowlink.auth.github-enabled=true",
    "flowlink.auth.jwt-secret=guest-mode-test-secret",
])
class GuestModeSecurityTest {

    @Autowired lateinit var mvc: MockMvc
    @Autowired lateinit var appJwt: AppJwt

    @Test
    fun `게스트 - 플로우 목록 조회 허용`() {
        mvc.perform(get("/api/v1/flows")).andExpect(status().isOk)
    }

    @Test
    fun `게스트 - 플로우 생성(쓰기) 허용`() {
        mvc.perform(post("/api/v1/flows").contentType("application/json")
            .content("""{"name":"게스트 플로우"}"""))
            .andExpect(status().isCreated)
    }

    @Test
    fun `게스트 - 플러그인 목록 허용(게스트 전권 - 사용자 결정)`() {
        mvc.perform(get("/api/v1/plugins")).andExpect(status().isOk)
    }

    @Test
    fun `게스트 - assistant 는 401`() {
        mvc.perform(get("/api/v1/assistant/config")).andExpect(status().isUnauthorized)
        mvc.perform(post("/api/v1/assistant/chat").contentType("application/json").content("{}"))
            .andExpect(status().isUnauthorized)
    }

    @Test
    fun `로그인 - assistant 허용`() {
        val token = appJwt.issue("alice")
        mvc.perform(get("/api/v1/assistant/config").header("Authorization", "Bearer $token"))
            .andExpect(status().isOk)
    }

    @Test
    fun `무효 토큰 - permitAll 경로도 401`() {
        mvc.perform(get("/api/v1/flows").header("Authorization", "Bearer bogus"))
            .andExpect(status().isUnauthorized)
    }

    @Test
    fun `게스트 - auth me 는 guest 전권`() {
        mvc.perform(get("/api/v1/auth/me"))
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.username").value("guest"))
            .andExpect(jsonPath("$.roles[?(@=='editor')]").exists())
    }

    @Test
    fun `게스트 - 플러그인 업로드는 인증 게이트에 안 걸림(401 아님)`() {
        // 멀티파트 없이 보내 415 등 4xx 가 나더라도, 핵심은 permitAll 이라 401(인증 게이트)이 아니라는 것.
        val result = mvc.perform(post("/api/v1/plugins")).andReturn()
        assert(result.response.status != 401) {
            "게스트 업로드가 인증 게이트에 걸렸다 (status=${result.response.status})"
        }
    }

    @Test
    fun `로그인 - auth me 는 JWT 사용자명 유지(개방 경로에서도 신원 인식)`() {
        val token = appJwt.issue("alice")
        mvc.perform(get("/api/v1/auth/me").header("Authorization", "Bearer $token"))
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.username").value("alice"))
    }
}
