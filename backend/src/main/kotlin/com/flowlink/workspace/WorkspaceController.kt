package com.flowlink.workspace

import com.flowlink.common.error.ForbiddenException
import com.flowlink.common.error.NotFoundException
import com.flowlink.common.tenant.TenantContext
import com.flowlink.core.domain.AppUser
import com.flowlink.core.repository.AppUserRepository
import jakarta.validation.Valid
import jakarta.validation.constraints.NotBlank
import org.springframework.http.HttpStatus
import org.springframework.transaction.annotation.Transactional
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController
import java.util.UUID

/** 워크스페이스 목록/생성/멤버 관리 — 롤 검사는 서비스가 수행. */
@RestController
@RequestMapping("/api/v1/workspaces")
class WorkspaceController(private val service: WorkspaceService) {

    @GetMapping
    fun list(): List<WorkspaceView> = service.listMine()

    data class CreateWorkspaceRequest(@field:NotBlank(message = "이름은 필수입니다.") val name: String)

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    fun create(@Valid @RequestBody req: CreateWorkspaceRequest): WorkspaceView = service.createTeam(req.name)

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun delete(@PathVariable id: UUID) = service.delete(id)

    @GetMapping("/{id}/members")
    fun members(@PathVariable id: UUID): List<MemberView> = service.members(id)

    data class PutMemberRequest(
        @field:NotBlank(message = "username 은 필수입니다.") val username: String,
        @field:NotBlank(message = "role 은 필수입니다.") val role: String,
    )

    @PutMapping("/{id}/members")
    fun putMember(@PathVariable id: UUID, @Valid @RequestBody req: PutMemberRequest): List<MemberView> {
        service.putMember(id, req.username, req.role)
        return service.members(id)
    }

    @DeleteMapping("/{id}/members/{username}")
    fun removeMember(@PathVariable id: UUID, @PathVariable username: String): List<MemberView> {
        service.removeMember(id, username)
        return service.members(id)
    }
}

/** 관리자 — 사용자 레지스트리/전역 롤 + 팀·권한 콘솔. (ADMIN 전용) */
@RestController
@RequestMapping("/api/v1/admin")
class AdminController(
    private val service: WorkspaceService,
    private val userRepo: AppUserRepository,
    private val wsRepo: com.flowlink.core.repository.WorkspaceRepository,
    private val memberRepo: com.flowlink.core.repository.WorkspaceMemberRepository,
    private val flowRepo: com.flowlink.core.repository.FlowRepository,
) {
    data class UserView(
        val username: String, val globalRole: String, val status: String,
        val lastSeenAt: String?, val createdAt: String?,
    )
    /** myStatus: GUEST(비로그인) | PENDING(승인 대기) | APPROVED | BLOCKED — 프론트가 대기 안내/AI 게이트에 사용. */
    data class MeView(
        val username: String, val admin: Boolean, val authenticated: Boolean,
        val pendingCount: Long = 0, val myStatus: String = "APPROVED",
    )
    data class AdminWorkspaceView(
        val id: String, val name: String, val kind: String, val ownerUsername: String?,
        val createdAt: String?, val flowCount: Long, val members: List<MemberView>,
    )
    data class AdminWorkspacesResponse(val publicFlowCount: Long, val workspaces: List<AdminWorkspaceView>)

    private fun requireAdmin() {
        if (!service.isAdmin(service.currentUsername())) throw ForbiddenException("관리자만 접근할 수 있습니다.")
    }

    /** 현재 사용자 요약 — 프론트가 관리 메뉴 노출 여부를 정한다. 관리자면 가입 신청 대기 수(네비 배지)도 함께. */
    @GetMapping("/me")
    @Transactional(readOnly = true)
    fun me(): MeView {
        val u = service.currentUsername()
        val admin = service.isAdmin(u)
        val pending = if (admin) {
            userRepo.findByTenantIdOrderByUsernameAsc(TenantContext.SHARED_FLOW_TENANT)
                .count { it.effectiveStatus() == AppUser.STATUS_PENDING }.toLong()
        } else 0L
        val myStatus = when {
            !service.isAuthenticated(u) -> "GUEST"
            service.isApproved(u) -> AppUser.STATUS_APPROVED
            else -> userRepo.findByTenantIdAndUsername(TenantContext.SHARED_FLOW_TENANT, u)
                .map { it.effectiveStatus() }.orElse(AppUser.STATUS_PENDING)
        }
        return MeView(u, admin, service.isAuthenticated(u), pending, myStatus)
    }

    @GetMapping("/users")
    @Transactional(readOnly = true)
    fun users(): List<UserView> {
        requireAdmin()
        return userRepo.findByTenantIdOrderByUsernameAsc(TenantContext.SHARED_FLOW_TENANT)
            .map { UserView(it.username, it.globalRole, it.effectiveStatus(), it.lastSeenAt?.toString(), it.createdAt?.toString()) }
    }

    /** 팀·권한 콘솔 한 화면용 — 전체 워크스페이스(팀+개인) + 멤버 + 워크플로 수를 1왕복으로. */
    @GetMapping("/workspaces")
    @Transactional(readOnly = true)
    fun workspaces(): AdminWorkspacesResponse {
        requireAdmin()
        val tenant = TenantContext.SHARED_FLOW_TENANT
        val list = wsRepo.findByTenantIdOrderByCreatedAtAsc(tenant).map { ws ->
            AdminWorkspaceView(
                ws.id.toString(), ws.name, ws.kind, ws.ownerUsername, ws.createdAt?.toString(),
                flowRepo.countByTenantIdAndArchivedFalseAndWorkspaceId(tenant, ws.id),
                memberRepo.findByWorkspaceIdOrderByCreatedAtAsc(ws.id).map { MemberView(it.username, it.role) },
            )
        }
        return AdminWorkspacesResponse(flowRepo.countByTenantIdAndArchivedFalseAndWorkspaceIdIsNull(tenant), list)
    }

    /** 전역 롤 및/또는 가입 상태 변경 — 둘 다 선택(주면 그것만 적용). 없는 사용자면 등록(테스트/사전 배정용). */
    data class PutUserRequest(val globalRole: String? = null, val status: String? = null)

    @PutMapping("/users/{username}")
    @Transactional
    fun putUser(@PathVariable username: String, @Valid @RequestBody req: PutUserRequest): UserView {
        requireAdmin()
        val name = username.trim().lowercase()
        val me = service.currentUsername()
        val u = userRepo.findByTenantIdAndUsername(TenantContext.SHARED_FLOW_TENANT, name)
            .orElseGet { userRepo.save(AppUser.of(TenantContext.SHARED_FLOW_TENANT, name, AppUser.STATUS_PENDING)) }
        req.globalRole?.trim()?.uppercase()?.let { role ->
            if (role != AppUser.ROLE_ADMIN && role != AppUser.ROLE_MEMBER) {
                throw com.flowlink.common.error.BadRequestException("globalRole 은 ADMIN 또는 MEMBER 여야 합니다.")
            }
            if (name == me) throw com.flowlink.common.error.BadRequestException("자기 자신의 전역 롤은 바꿀 수 없습니다.")
            u.globalRole = role
        }
        req.status?.trim()?.uppercase()?.let { st ->
            if (st !in setOf(AppUser.STATUS_PENDING, AppUser.STATUS_APPROVED, AppUser.STATUS_BLOCKED)) {
                throw com.flowlink.common.error.BadRequestException("status 는 PENDING/APPROVED/BLOCKED 중 하나여야 합니다.")
            }
            if (name == me && st != AppUser.STATUS_APPROVED) {
                throw com.flowlink.common.error.BadRequestException("자기 자신을 차단/대기 상태로 바꿀 수 없습니다.")
            }
            u.status = st
        }
        userRepo.save(u)
        return UserView(u.username, u.globalRole, u.effectiveStatus(), u.lastSeenAt?.toString(), u.createdAt?.toString())
    }

    @DeleteMapping("/users/{username}")
    @Transactional
    fun deleteUser(@PathVariable username: String) {
        requireAdmin()
        val u = userRepo.findByTenantIdAndUsername(TenantContext.SHARED_FLOW_TENANT, username.trim().lowercase())
            .orElseThrow { NotFoundException.of("User", username) }
        // 팀 멤버십 정리 + 개인 워크스페이스를 삭제 실행 관리자의 개인 ws 로 흡수(핸들 재사용 시 데이터 승계 방지).
        // 소유자 없는 팀은 유지 — 관리자는 모든 워크스페이스 OWNER 격이라 계속 관리 가능.
        service.purgeUser(u.username)
        userRepo.delete(u)
    }
}
