package com.flowlink.workspace

import com.flowlink.common.error.BadRequestException
import com.flowlink.common.error.ForbiddenException
import com.flowlink.common.error.NotFoundException
import com.flowlink.common.tenant.TenantContext
import com.flowlink.core.domain.AppUser
import com.flowlink.core.domain.Workspace
import com.flowlink.core.domain.WorkspaceMember
import com.flowlink.core.repository.AppUserRepository
import com.flowlink.core.repository.WorkspaceMemberRepository
import com.flowlink.core.repository.WorkspaceRepository
import com.flowlink.security.AuthProperties
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.security.oauth2.jwt.Jwt
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Instant
import java.util.UUID

/**
 * 워크스페이스(폴더 위 최상위 그룹) + 롤 기반 접근.
 *  - 공용: DB 행 없는 가상 스코프(workspace_id=null) — 모두(게스트 포함) EDITOR. 기존 데이터/동작 100% 호환.
 *  - 개인: 로그인 사용자마다 자동 생성, 소유자 OWNER 전용(관리자는 열람 가능).
 *  - 팀: 멤버십 롤(OWNER/EDITOR/VIEWER). 전역 ADMIN 은 모든 워크스페이스 OWNER 격.
 * dev 모드(인증 없음)의 사용자는 'dev'(ADMIN) — 로컬에서 모든 기능이 마찰 없이 동작한다.
 */
@Service
class WorkspaceService(
    private val wsRepo: WorkspaceRepository,
    private val memberRepo: WorkspaceMemberRepository,
    private val userRepo: AppUserRepository,
    private val flowRepo: com.flowlink.core.repository.FlowRepository,
    private val folderRepo: com.flowlink.core.repository.FolderRepository,
    private val auth: AuthProperties,
) {
    companion object {
        const val PUBLIC_ID = "public" // 가상 공용 워크스페이스 id(API 표현)
        const val GUEST = "guest"
        const val DEV_USER = "dev"
    }

    private fun tenant(): String = TenantContext.SHARED_FLOW_TENANT

    /** 현재 사용자명 — JWT(preferred_username) → github 모드 비로그인 'guest' → dev 모드 'dev'. */
    fun currentUsername(): String {
        val a = SecurityContextHolder.getContext().authentication
        val p = a?.principal
        if (p is Jwt) {
            val u = p.getClaimAsString("preferred_username") ?: p.subject
            if (!u.isNullOrBlank()) return u.lowercase()
        }
        return if (auth.githubEnabled) GUEST else DEV_USER
    }

    fun isAuthenticated(username: String): Boolean = username != GUEST

    @Transactional
    fun isAdmin(username: String): Boolean {
        if (username == DEV_USER) return true // dev 모드 = 로컬 단독 사용 — 전권
        if (auth.isBootstrapAdmin(username)) return true
        return userRepo.findByTenantIdAndUsername(tenant(), username)
            .map { it.globalRole == AppUser.ROLE_ADMIN }.orElse(false)
    }

    /** 사용자 자동 등록/최근 활동 갱신 — 로그인 사용자의 워크스페이스 조회 시점에 호출. */
    @Transactional
    fun touchUser(username: String) {
        if (!isAuthenticated(username)) return
        val u = userRepo.findByTenantIdAndUsername(tenant(), username).orElseGet {
            userRepo.save(AppUser.of(tenant(), username))
        }
        u.lastSeenAt = Instant.now()
        userRepo.save(u)
    }

    /** 개인 워크스페이스 보장(없으면 생성). */
    @Transactional
    fun ensurePersonal(username: String): Workspace? {
        if (!isAuthenticated(username)) return null
        return wsRepo.findByTenantIdAndKindAndOwnerUsername(tenant(), Workspace.KIND_PERSONAL, username)
            .orElseGet { wsRepo.save(Workspace.personal(tenant(), username, "개인 — $username")) }
    }

    /** 워크스페이스에서의 내 롤 — null(공용)=EDITOR(모두), 개인=소유자 OWNER, 팀=멤버십. 관리자=OWNER. 접근 불가면 null. */
    @Transactional
    fun roleFor(username: String, workspaceId: UUID?): String? {
        if (workspaceId == null) return WorkspaceMember.ROLE_EDITOR // 공용 — 게스트 포함 편집 개방(기존 동작)
        if (isAdmin(username)) return WorkspaceMember.ROLE_OWNER
        val ws = wsRepo.findByIdAndTenantId(workspaceId, tenant()).orElse(null) ?: return null
        if (ws.kind == Workspace.KIND_PERSONAL) {
            return if (ws.ownerUsername == username) WorkspaceMember.ROLE_OWNER else null
        }
        return memberRepo.findByWorkspaceIdAndUsername(workspaceId, username).map { it.role }.orElse(null)
    }

    /** 읽기 권한 강제(없으면 403). */
    fun requireRead(username: String, workspaceId: UUID?) {
        roleFor(username, workspaceId) ?: throw ForbiddenException("이 워크스페이스에 접근 권한이 없습니다.")
    }

    /** 쓰기 권한 강제(EDITOR 이상). */
    fun requireWrite(username: String, workspaceId: UUID?) {
        val r = roleFor(username, workspaceId) ?: throw ForbiddenException("이 워크스페이스에 접근 권한이 없습니다.")
        if (r == WorkspaceMember.ROLE_VIEWER) throw ForbiddenException("viewer 롤은 조회만 가능합니다.")
    }

    /** 관리 권한 강제(OWNER). */
    fun requireOwner(username: String, workspaceId: UUID) {
        val r = roleFor(username, workspaceId)
        if (r != WorkspaceMember.ROLE_OWNER) throw ForbiddenException("워크스페이스 소유자만 가능합니다.")
    }

    /** 문자열 워크스페이스 id 해석 — 'public'/공백=null(공용), UUID=팀/개인. */
    fun resolveId(raw: String?): UUID? {
        val t = raw?.trim()
        if (t.isNullOrEmpty() || t == PUBLIC_ID) return null
        return try { UUID.fromString(t) } catch (e: IllegalArgumentException) {
            throw BadRequestException("workspaceId 가 올바르지 않습니다: $t")
        }
    }

    /** 내가 볼 수 있는 워크스페이스 목록 — 공용 + 개인 + 멤버 팀(+관리자는 전체 팀/개인). */
    @Transactional
    fun listMine(): List<WorkspaceView> {
        val me = currentUsername()
        touchUser(me)
        val out = ArrayList<WorkspaceView>()
        out.add(WorkspaceView(PUBLIC_ID, "공용", "PUBLIC", WorkspaceMember.ROLE_EDITOR, isAdmin(me)))
        val personal = ensurePersonal(me)
        if (personal != null) out.add(WorkspaceView(personal.id.toString(), personal.name, personal.kind, WorkspaceMember.ROLE_OWNER, true))
        val admin = isAdmin(me)
        if (admin) {
            for (ws in wsRepo.findByTenantIdOrderByCreatedAtAsc(tenant())) {
                if (ws.id == personal?.id) continue
                out.add(WorkspaceView(ws.id.toString(), ws.name, ws.kind, WorkspaceMember.ROLE_OWNER, true))
            }
        } else {
            for (m in memberRepo.findByUsername(me)) {
                val ws = wsRepo.findByIdAndTenantId(m.workspaceId, tenant()).orElse(null) ?: continue
                out.add(WorkspaceView(ws.id.toString(), ws.name, ws.kind, m.role, m.role == WorkspaceMember.ROLE_OWNER))
            }
        }
        return out
    }

    @Transactional
    fun createTeam(name: String): WorkspaceView {
        val me = currentUsername()
        if (!isAuthenticated(me)) throw ForbiddenException("팀 워크스페이스는 로그인 후 만들 수 있습니다.")
        val n = name.trim()
        if (n.isEmpty()) throw BadRequestException("워크스페이스 이름을 입력하세요.")
        val ws = wsRepo.save(Workspace.team(tenant(), n))
        memberRepo.save(WorkspaceMember.of(ws.id, me, WorkspaceMember.ROLE_OWNER))
        return WorkspaceView(ws.id.toString(), ws.name, ws.kind, WorkspaceMember.ROLE_OWNER, true)
    }

    @Transactional
    fun delete(workspaceId: UUID) {
        val me = currentUsername()
        val ws = wsRepo.findByIdAndTenantId(workspaceId, tenant()).orElseThrow { NotFoundException.of("Workspace", workspaceId) }
        // 개인 워크스페이스는 소유자도 못 지운다(자동 재생성될 뿐) — 단 관리자는 정리 가능(탈퇴자 잔여 공간 등)
        if (ws.kind == Workspace.KIND_PERSONAL && !isAdmin(me)) throw BadRequestException("개인 워크스페이스는 삭제할 수 없습니다.")
        requireOwner(me, workspaceId)
        memberRepo.deleteByWorkspaceId(workspaceId)
        // 안의 플로우/폴더는 공용으로 승격 — 데이터 유실 방지(정리는 사용자가)
        flowRepo.clearWorkspace(workspaceId)
        folderRepo.clearWorkspace(workspaceId)
        wsRepo.delete(ws)
    }

    @Transactional
    fun members(workspaceId: UUID): List<MemberView> {
        requireRead(currentUsername(), workspaceId)
        return memberRepo.findByWorkspaceIdOrderByCreatedAtAsc(workspaceId).map { MemberView(it.username, it.role) }
    }

    @Transactional
    fun putMember(workspaceId: UUID, username: String, role: String) {
        val me = currentUsername()
        requireOwner(me, workspaceId)
        val u = username.trim().lowercase()
        if (u.isEmpty()) throw BadRequestException("사용자명을 입력하세요.")
        if (role !in setOf(WorkspaceMember.ROLE_OWNER, WorkspaceMember.ROLE_EDITOR, WorkspaceMember.ROLE_VIEWER)) {
            throw BadRequestException("role 은 OWNER/EDITOR/VIEWER 중 하나여야 합니다.")
        }
        val existing = memberRepo.findByWorkspaceIdAndUsername(workspaceId, u).orElse(null)
        if (existing != null) {
            existing.role = role
            memberRepo.save(existing)
        } else {
            memberRepo.save(WorkspaceMember.of(workspaceId, u, role))
        }
        // 사용자 레지스트리에도 등록(관리 화면 목록)
        userRepo.findByTenantIdAndUsername(tenant(), u).orElseGet { userRepo.save(AppUser.of(tenant(), u)) }
    }

    @Transactional
    fun removeMember(workspaceId: UUID, username: String) {
        val me = currentUsername()
        requireOwner(me, workspaceId)
        val u = username.trim().lowercase()
        val members = memberRepo.findByWorkspaceIdOrderByCreatedAtAsc(workspaceId)
        val target = members.find { it.username == u } ?: return
        if (target.role == WorkspaceMember.ROLE_OWNER && members.count { it.role == WorkspaceMember.ROLE_OWNER } <= 1) {
            throw BadRequestException("마지막 OWNER 는 내보낼 수 없습니다.")
        }
        memberRepo.delete(target)
    }
}

data class WorkspaceView(
    val id: String,          // 'public' 또는 UUID
    val name: String,
    val kind: String,        // PUBLIC | PERSONAL | TEAM
    val myRole: String,      // OWNER | EDITOR | VIEWER
    val canManage: Boolean,
)

data class MemberView(val username: String, val role: String)
