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
import java.util.UUID

/**
 * github 로그인 모드(기본, guest-enabled=false) 보안 경계 — **모든 API 로그인 필수**.
 * 부트스트랩(/auth/config·device)만 공개, 나머지는 무토큰이면 401. 외부 시스템 경로(mock/relay/hooks)는 인증 게이트 밖.
 * (jwt-secret 미설정 → 자동 생성 경로. 스키마: H2 인메모리 create-drop, Flyway off.)
 */
@SpringBootTest
@AutoConfigureMockMvc
@TestPropertySource(properties = [
    "spring.datasource.url=jdbc:h2:mem:forcelogin;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE",
    "spring.datasource.driver-class-name=org.h2.Driver",
    "spring.datasource.username=sa",
    "spring.datasource.password=",
    "spring.jpa.hibernate.ddl-auto=create-drop",
    "flowlink.auth.github-enabled=true",
])
class ForceLoginSecurityTest {

    @Autowired lateinit var mvc: MockMvc
    @Autowired lateinit var appJwt: AppJwt

    @Test
    fun `무토큰 - 플로우 목록은 401`() {
        mvc.perform(get("/api/v1/flows")).andExpect(status().isUnauthorized)
    }

    @Test
    fun `무토큰 - 플로우 생성은 401`() {
        mvc.perform(post("/api/v1/flows").contentType("application/json").content("""{"name":"x"}"""))
            .andExpect(status().isUnauthorized)
    }

    @Test
    fun `무토큰 - auth me 는 401`() {
        mvc.perform(get("/api/v1/auth/me")).andExpect(status().isUnauthorized)
    }

    @Test
    fun `공개 - auth config 는 무토큰도 200(부트스트랩)`() {
        mvc.perform(get("/api/v1/auth/config"))
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.mode").value("github"))
    }

    @Test
    fun `로그인 - 플로우 목록 허용`() {
        val token = appJwt.issue("alice")
        mvc.perform(get("/api/v1/flows").header("Authorization", "Bearer $token")).andExpect(status().isOk)
    }

    @Test
    fun `로그인 - assistant 허용, 무토큰은 401`() {
        mvc.perform(get("/api/v1/assistant/config")).andExpect(status().isUnauthorized)
        val token = appJwt.issue("alice")
        mvc.perform(get("/api/v1/assistant/config").header("Authorization", "Bearer $token")).andExpect(status().isOk)
    }

    @Test
    fun `무효 토큰 - 401`() {
        mvc.perform(get("/api/v1/flows").header("Authorization", "Bearer bogus")).andExpect(status().isUnauthorized)
    }

    @Test
    fun `외부 시스템 경로 - 남의 Authorization 을 실어도 인증 게이트에 안 걸림`() {
        val calls = mapOf(
            "mock" to get("/mock/nope/ping").header("Authorization", "Bearer someone-elses-token"),
            "relay" to post("/relay/${UUID.randomUUID()}/cb/n1").header("Authorization", "Basic dXNlcjpwYXNz")
                .contentType("application/json").content("{}"),
            "webhook" to post("/hooks/nope").header("Authorization", "Bearer someone-elses-token")
                .contentType("application/json").content("{}"),
        )
        calls.forEach { (name, req) ->
            val s = mvc.perform(req).andReturn().response.status
            assert(s != 401) { "$name 이 인증 게이트에 걸렸다 (status=$s)" }
        }
    }
}

/**
 * github + 게스트 스위치 ON(guest-enabled=true) — MCP 에이전트가 로그인 없이 쓰라고 남겨 둔 통로.
 * 무인증 API 허용(게스트 전권), assistant 만 로그인 필수.
 */
@SpringBootTest
@AutoConfigureMockMvc
@TestPropertySource(properties = [
    "spring.datasource.url=jdbc:h2:mem:gueston;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE",
    "spring.datasource.driver-class-name=org.h2.Driver",
    "spring.datasource.username=sa",
    "spring.datasource.password=",
    "spring.jpa.hibernate.ddl-auto=create-drop",
    "flowlink.auth.github-enabled=true",
    "flowlink.auth.guest-enabled=true",
])
class GuestModeEnabledTest {

    @Autowired lateinit var mvc: MockMvc
    @Autowired lateinit var appJwt: AppJwt

    @Test
    fun `게스트 - 플로우 목록 조회 허용`() {
        mvc.perform(get("/api/v1/flows")).andExpect(status().isOk)
    }

    @Test
    fun `게스트 - 플로우 생성(쓰기) 허용`() {
        mvc.perform(post("/api/v1/flows").contentType("application/json").content("""{"name":"게스트 플로우"}"""))
            .andExpect(status().isCreated)
    }

    @Test
    fun `게스트 - assistant 는 401`() {
        mvc.perform(get("/api/v1/assistant/config")).andExpect(status().isUnauthorized)
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
        val result = mvc.perform(post("/api/v1/plugins")).andReturn()
        assert(result.response.status != 401) { "게스트 업로드가 인증 게이트에 걸렸다 (status=${result.response.status})" }
    }

    @Test
    fun `로그인 - auth me 는 JWT 사용자명 유지`() {
        val token = appJwt.issue("alice")
        mvc.perform(get("/api/v1/auth/me").header("Authorization", "Bearer $token"))
            .andExpect(status().isOk)
            .andExpect(jsonPath("$.username").value("alice"))
    }
}
