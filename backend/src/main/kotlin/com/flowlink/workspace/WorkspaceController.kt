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
    data class UserView(val username: String, val globalRole: String, val lastSeenAt: String?)
    data class MeView(val username: String, val admin: Boolean, val authenticated: Boolean)
    data class AdminWorkspaceView(
        val id: String, val name: String, val kind: String, val ownerUsername: String?,
        val createdAt: String?, val flowCount: Long, val members: List<MemberView>,
    )
    data class AdminWorkspacesResponse(val publicFlowCount: Long, val workspaces: List<AdminWorkspaceView>)

    private fun requireAdmin() {
        if (!service.isAdmin(service.currentUsername())) throw ForbiddenException("관리자만 접근할 수 있습니다.")
    }

    /** 현재 사용자 요약 — 프론트가 관리 메뉴 노출 여부를 정한다. */
    @GetMapping("/me")
    fun me(): MeView {
        val u = service.currentUsername()
        return MeView(u, service.isAdmin(u), service.isAuthenticated(u))
    }

    @GetMapping("/users")
    @Transactional(readOnly = true)
    fun users(): List<UserView> {
        requireAdmin()
        return userRepo.findByTenantIdOrderByUsernameAsc(TenantContext.SHARED_FLOW_TENANT)
            .map { UserView(it.username, it.globalRole, it.lastSeenAt?.toString()) }
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

    data class PutUserRequest(@field:NotBlank(message = "globalRole 은 필수입니다.") val globalRole: String)

    @PutMapping("/users/{username}")
    @Transactional
    fun putUser(@PathVariable username: String, @Valid @RequestBody req: PutUserRequest): UserView {
        requireAdmin()
        val role = req.globalRole.trim().uppercase()
        if (role != AppUser.ROLE_ADMIN && role != AppUser.ROLE_MEMBER) {
            throw com.flowlink.common.error.BadRequestException("globalRole 은 ADMIN 또는 MEMBER 여야 합니다.")
        }
        val u = userRepo.findByTenantIdAndUsername(TenantContext.SHARED_FLOW_TENANT, username.trim().lowercase())
            .orElseGet { userRepo.save(AppUser.of(TenantContext.SHARED_FLOW_TENANT, username.trim().lowercase())) }
        u.globalRole = role
        userRepo.save(u)
        return UserView(u.username, u.globalRole, u.lastSeenAt?.toString())
    }

    @DeleteMapping("/users/{username}")
    @Transactional
    fun deleteUser(@PathVariable username: String) {
        requireAdmin()
        val u = userRepo.findByTenantIdAndUsername(TenantContext.SHARED_FLOW_TENANT, username.trim().lowercase())
            .orElseThrow { NotFoundException.of("User", username) }
        // 팀 멤버십도 함께 정리 — 삭제된 사용자가 팀 목록에 유령으로 남지 않게(팀 자체·개인 워크스페이스는 유지,
        // 관리자는 모든 워크스페이스 OWNER 격이라 소유자 없는 팀도 계속 관리 가능).
        memberRepo.findByUsername(u.username).forEach { memberRepo.delete(it) }
        userRepo.delete(u)
    }
}
