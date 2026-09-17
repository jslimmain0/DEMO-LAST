package com.flowlink.plugin

import com.flowlink.common.error.BadRequestException
import com.flowlink.common.error.ForbiddenException
import com.flowlink.core.domain.AppUser
import com.flowlink.core.domain.PluginScript
import com.flowlink.core.repository.AppUserRepository
import com.flowlink.core.repository.PluginScriptRepository
import com.flowlink.plugin.script.ScriptError
import com.flowlink.transform.TransformRegistry
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatCode
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.security.oauth2.jwt.Jwt
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken
import org.springframework.test.context.TestPropertySource

/** 초안 → 승인 요청 → 승인 → 레지스트리 등장. 게이트(승인 사용자 쓰기·관리자 승인)는 JWT 를 심어 검증(WorkspaceRbacTest 관례). */
@SpringBootTest
@TestPropertySource(properties = [
    "spring.datasource.url=jdbc:h2:mem:pluginlifecycle;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE",
    "spring.datasource.driver-class-name=org.h2.Driver",
    "spring.datasource.username=sa",
    "spring.datasource.password=",
    "spring.jpa.hibernate.ddl-auto=create-drop",
    "flowlink.auth.github-enabled=true",
])
class PluginScriptLifecycleTest {
    @Autowired lateinit var svc: PluginScriptService
    @Autowired lateinit var registry: TransformRegistry
    @Autowired lateinit var userRepo: AppUserRepository
    @Autowired lateinit var repo: PluginScriptRepository

    private val T = com.flowlink.common.tenant.TenantContext.SHARED_FLOW_TENANT
    private val SRC = "({ id: 'up1', label: '대문자', inputs: [{ key: 'input', label: '원문' }], apply(i, c) { fl.log('run'); return { result: i.input.toUpperCase() } } })"

    @AfterEach fun clear() { repo.deleteAll(); registry.reload(); SecurityContextHolder.clearContext() }
    private fun asUser(name: String) {
        val jwt = Jwt.withTokenValue("t").header("alg", "none").claim("preferred_username", name).subject(name).build()
        SecurityContextHolder.getContext().authentication = JwtAuthenticationToken(jwt)
    }
    private fun user(name: String, status: String, role: String = AppUser.ROLE_MEMBER) {
        val u = userRepo.findByTenantIdAndUsername(T, name).orElseGet { userRepo.save(AppUser.of(T, name)) }
        u.status = status; u.globalRole = role; userRepo.save(u)
    }

    @Test
    fun `초안 저장 → 시험 실행 → 승인 요청 → 관리자 승인 → 레지스트리에 등장, 반려는 승인본 유지`() {
        user("alice", AppUser.STATUS_APPROVED); user("admin", AppUser.STATUS_APPROVED, AppUser.ROLE_ADMIN)
        asUser("alice")
        val d = svc.create(PluginScriptDtos.SaveRequest("대문자", SRC))
        assertThat(d.status).isEqualTo(PluginScript.STATUS_DRAFT); assertThat(d.pluginId).isEqualTo("up1"); assertThat(d.meta!!.inputs.single().key).isEqualTo("input")
        assertThat(registry.get("up1")).isEmpty

        val tr = svc.tryRun(PluginScriptDtos.TryRequest(source = SRC, inputs = mapOf("input" to "ab")))
        assertThat(tr.outputs).containsEntry("result", "AB"); assertThat(tr.logs).containsExactly("run")

        assertThatThrownBy { svc.approve(d.id) }.isInstanceOf(ForbiddenException::class.java) // 관리자 아님
        val p = svc.submit(d.id); assertThat(p.status).isEqualTo(PluginScript.STATUS_PENDING); assertThat(p.submittedBy).isEqualTo("alice")
        assertThat(svc.pendingCount()).isEqualTo(1)

        asUser("admin")
        val a = svc.approve(d.id)
        assertThat(a.status).isEqualTo(PluginScript.STATUS_APPROVED); assertThat(a.live).isTrue(); assertThat(a.liveSource).isEqualTo(SRC)
        assertThat(registry.get("up1")).isPresent
        assertThat(registry.get("up1").get().apply(mapOf("input" to "x"), emptyMap())).containsEntry("result", "X")

        // 수정 → 초안만 바뀌고 서빙은 그대로(dirty)
        asUser("alice")
        val u = svc.update(d.id, PluginScriptDtos.SaveRequest(null, SRC.replace("toUpperCase", "toLowerCase")))
        assertThat(u.dirty).isTrue(); assertThat(u.status).isEqualTo(PluginScript.STATUS_APPROVED)
        assertThat(registry.get("up1").get().apply(mapOf("input" to "x"), emptyMap())).containsEntry("result", "X")
        svc.submit(d.id)
        asUser("admin")
        val r = svc.reject(d.id, "이유")
        assertThat(r.status).isEqualTo(PluginScript.STATUS_REJECTED); assertThat(r.reviewNote).isEqualTo("이유"); assertThat(r.live).isTrue()
        assertThat(registry.get("up1").get().apply(mapOf("input" to "x"), emptyMap())).containsEntry("result", "X")

        // 삭제(사용처 0) → 레지스트리에서 사라짐
        svc.delete(d.id)
        assertThat(registry.get("up1")).isEmpty
    }

    @Test
    fun `컴파일 실패는 ScriptError(400) - 줄 번호, pluginId 중복은 400, 미승인 사용자는 403, 게스트는 403`() {
        user("alice", AppUser.STATUS_APPROVED); user("pend", AppUser.STATUS_PENDING)
        asUser("alice")
        assertThatThrownBy { svc.create(PluginScriptDtos.SaveRequest("x", "({ id: 'x',\n label: 'x' apply() {} })")) }
            .isInstanceOf(ScriptError::class.java).matches { (it as ScriptError).line == 2 }
        svc.create(PluginScriptDtos.SaveRequest("a", SRC))
        assertThatThrownBy { svc.create(PluginScriptDtos.SaveRequest("b", SRC)) }.isInstanceOf(BadRequestException::class.java).hasMessageContaining("up1")
        asUser("pend")
        assertThatThrownBy { svc.create(PluginScriptDtos.SaveRequest("c", SRC.replace("up1", "up2"))) }.isInstanceOf(ForbiddenException::class.java)
        assertThatThrownBy { svc.tryRun(PluginScriptDtos.TryRequest(source = SRC)) }.isInstanceOf(ForbiddenException::class.java)
        SecurityContextHolder.clearContext() // github 모드 무토큰 = guest
        assertThat(svc.list()).isNotEmpty // 읽기는 허용
        assertThatThrownBy { svc.create(PluginScriptDtos.SaveRequest("d", SRC.replace("up1", "up3"))) }.isInstanceOf(ForbiddenException::class.java)
    }

    @Test
    fun `try - fieldCodec 과 messageCodec 도 시험 가능, 컴파일만(입력 없음)이면 meta 만`() {
        user("alice", AppUser.STATUS_APPROVED); asUser("alice")
        val fc = "({ id: 'fc1', label: 'F', kind: 'fieldCodec', encode(v, ctx) { return v + '!' + ctx.direction }, decode(v, ctx) { return v.slice(0, -5) } })"
        assertThat(svc.tryRun(PluginScriptDtos.TryRequest(source = fc, value = "a", fn = "encode", direction = "send")).result).isEqualTo("a!send")
        val mc = "({ id: 'mc1', label: 'M', kind: 'messageCodec', encode(b, ctx) { return b.map((x) => x ^ 1) }, decode(b, ctx) { return b.map((x) => x ^ 1) } })"
        assertThat(svc.tryRun(PluginScriptDtos.TryRequest(source = mc, fn = "encode", bytesB64 = "AQI=")).bytesB64).isEqualTo("AAM=")
        val metaOnly = svc.tryRun(PluginScriptDtos.TryRequest(source = SRC))
        assertThat(metaOnly.meta.id).isEqualTo("up1"); assertThat(metaOnly.outputs).isNull()
    }

    @Test
    fun `깨진 승인본 행은 건너뛰고 나머지 승인본은 로드된다`() {
        user("alice", AppUser.STATUS_APPROVED); user("admin", AppUser.STATUS_APPROVED, AppUser.ROLE_ADMIN)
        asUser("alice")
        val d = svc.create(PluginScriptDtos.SaveRequest("대문자", SRC))
        svc.submit(d.id)
        asUser("admin")
        svc.approve(d.id)

        repo.saveAndFlush(PluginScript.create(T, "broken-one", "깨진", "transform", "({ id: 'broken-one', label: 'x', apply() {} })", "admin")
            .also { it.liveSource = "this is not js {"; it.status = PluginScript.STATUS_APPROVED })

        assertThatCode { registry.reload() }.doesNotThrowAnyException()
        assertThat(registry.get("up1")).isPresent
        assertThat(registry.get("broken-one")).isEmpty
    }

    @Test
    fun `승인된 플러그인의 id 는 바꿀 수 없다`() {
        user("alice", AppUser.STATUS_APPROVED); user("admin", AppUser.STATUS_APPROVED, AppUser.ROLE_ADMIN)
        asUser("alice")
        val d = svc.create(PluginScriptDtos.SaveRequest("대문자", SRC))
        svc.submit(d.id)
        asUser("admin")
        svc.approve(d.id)

        asUser("alice")
        assertThatThrownBy { svc.update(d.id, PluginScriptDtos.SaveRequest(null, SRC.replace("up1", "up9"))) }
            .isInstanceOf(BadRequestException::class.java).hasMessageContaining("바꿀 수 없습니다")
    }
}
