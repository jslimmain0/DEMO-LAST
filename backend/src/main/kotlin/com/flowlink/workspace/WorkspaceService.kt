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
    private val mockRepo: com.flowlink.core.repository.MockServerRepository,
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

    // isAdmin DB 판정 5초 캐시 — 실행 폴링(0.4초 간격)의 requireRead 경로가 매 tick 사용자 행을 조회하던 것 완화.
    // 롤 변경(putUser)·삭제 시 즉시 무효화. env/dev 판정은 캐시 불필요(메모리 비교).
    private val adminCache = java.util.concurrent.ConcurrentHashMap<String, Pair<Long, Boolean>>()

    fun invalidateRoleCache(username: String) { adminCache.remove(username.lowercase()) }

    @Transactional
    fun isAdmin(username: String): Boolean {
        if (username == DEV_USER) return true // dev 모드 = 로컬 단독 사용 — 전권
        if (auth.isBootstrapAdmin(username)) return true
        val now = System.currentTimeMillis()
        adminCache[username]?.let { if (now - it.first < 5_000) return it.second }
        val v = userRepo.findByTenantIdAndUsername(tenant(), username)
            .map { it.globalRole == AppUser.ROLE_ADMIN }.orElse(false)
        adminCache[username] = now to v
        return v
    }

    /**
     * 사용자 자동 등록/최근 활동 갱신 — 로그인 사용자의 활동 시점에 호출.
     * **처음 관측되는 사용자는 PENDING(가입 신청)으로 등록** → 관리 콘솔에서 승인.
     * 관리자·화이트리스트(allowed-logins 명시) 사용자는 자동 승인.
     */
    @Transactional
    fun touchUser(username: String) {
        if (!isAuthenticated(username)) return
        val u = userRepo.findByTenantIdAndUsername(tenant(), username).orElseGet {
            userRepo.save(AppUser.of(tenant(), username, defaultStatus(username)))
        }
        u.lastSeenAt = Instant.now()
        userRepo.save(u)
    }

    /** 신규 등록 기본 상태 — 관리자/명시 화이트리스트는 APPROVED, 그 외 PENDING(가입 신청). */
    fun defaultStatus(username: String): String =
        if (username == DEV_USER || auth.isBootstrapAdmin(username) ||
            (auth.allowedLogins.isNotEmpty() && auth.allows(username))
        ) AppUser.STATUS_APPROVED else AppUser.STATUS_PENDING

    /**
     * 가입 승인 여부 — **승인된 사용자만** 개인 워크스페이스·팀 생성·AI 를 쓴다(팀 접근은 멤버십으로 별도 판정).
     * 관리자·dev·명시 화이트리스트는 항상 승인. 레거시 행(status=null)도 승인 간주.
     */
    @Transactional
    fun isApproved(username: String): Boolean {
        if (!isAuthenticated(username)) return false
        // 차단이 화이트리스트/DB-ADMIN 보다 우선 — 차단해도 allowed-logins 우회로 AI 가 살아있던 구멍 방지.
        // (env 부트스트랩 관리자만 예외 — 관리자 전원이 서로 차단해 잠기는 사고 방지)
        val row = userRepo.findByTenantIdAndUsername(tenant(), username).orElse(null)
        if (row?.effectiveStatus() == AppUser.STATUS_BLOCKED && !auth.isBootstrapAdmin(username) && username != DEV_USER) {
            return false
        }
        if (username == DEV_USER || isAdmin(username)) return true
        if (auth.allowedLogins.isNotEmpty() && auth.allows(username)) return true
        return row?.effectiveStatus() == AppUser.STATUS_APPROVED
    }

    /** 개인 워크스페이스 보장(없으면 생성) — **승인된 사용자만**(가입 신청 중에는 공용만 사용). */
    @Transactional
    fun ensurePersonal(username: String): Workspace? {
        if (!isAuthenticated(username) || !isApproved(username)) return null
        // 동시 첫 로그인 레이스는 V16 유니크 인덱스가 이중 생성을 막는다 — 진 쪽 요청은 1회 실패 후
        // 다음 요청에서 이긴 행을 찾는다(트랜잭션 rollback-only 때문에 같은 tx 내 catch-재조회는 불가).
        return wsRepo.findByTenantIdAndKindAndOwnerUsername(tenant(), Workspace.KIND_PERSONAL, username)
            .orElseGet { wsRepo.save(Workspace.personal(tenant(), username, "개인 — $username")) }
    }

    /** 워크스페이스에서의 내 롤 — null(공용)=EDITOR(모두), 개인=소유자 OWNER, 팀=멤버십. 관리자=OWNER. 접근 불가면 null. */
    @Transactional
    fun roleFor(username: String, workspaceId: UUID?): String? {
        if (workspaceId == null) return WorkspaceMember.ROLE_EDITOR // 공용 — 게스트 포함 편집 개방(기존 동작)
        // 존재 확인을 admin 단축 경로보다 먼저 — 없는 ws id 에 관리자가 OWNER 로 판정되면
        // 존재하지 않는 워크스페이스에 flow 를 배정해 고아 데이터를 만들 수 있다.
        val ws = wsRepo.findByIdAndTenantId(workspaceId, tenant()).orElse(null) ?: return null
        if (isAdmin(username)) return WorkspaceMember.ROLE_OWNER
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
                // 개인 ws 멤버십 행(비정상 데이터)·자기 개인 ws 중복은 목록에서 제외 — 진입 불가/중복 표시 방지
                if (ws.kind == Workspace.KIND_PERSONAL || ws.id == personal?.id) continue
                out.add(WorkspaceView(ws.id.toString(), ws.name, ws.kind, m.role, m.role == WorkspaceMember.ROLE_OWNER))
            }
        }
        return out
    }

    @Transactional
    fun createTeam(name: String): WorkspaceView {
        val me = currentUsername()
        if (!isAuthenticated(me)) throw ForbiddenException("팀 워크스페이스는 로그인 후 만들 수 있습니다.")
        if (!isApproved(me)) throw ForbiddenException("가입 승인 대기 중입니다 — 관리자 승인 후 팀을 만들 수 있습니다.")
        val n = name.trim()
        if (n.isEmpty()) throw BadRequestException("워크스페이스 이름을 입력하세요.")
        if (n.length > 120) throw BadRequestException("워크스페이스 이름은 120자 이하여야 합니다.")
        if (wsRepo.findByTenantIdOrderByCreatedAtAsc(tenant()).any { it.kind == Workspace.KIND_TEAM && it.name == n }) {
            throw BadRequestException("같은 이름의 팀이 이미 있습니다: $n")
        }
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
        // 안의 플로우/폴더/Mock 은 **삭제 실행자의 개인 워크스페이스로 이관** — 공용 승격은 비공개 데이터를
        // 게스트 포함 전원에게 공개하는 권한 상승이었다(적대 리뷰 [H]). 개인 ws 가 없으면(이론상 없음) 공용 폴백.
        val target = ensurePersonal(me)?.id
        flowRepo.reassignWorkspace(workspaceId, target)
        folderRepo.reassignWorkspace(workspaceId, target)
        mockRepo.reassignWorkspace(workspaceId, target)
        wsRepo.delete(ws)
    }

    /**
     * 관리자 사용자 삭제의 워크스페이스 정리 — 팀 멤버십 제거 + **개인 ws 를 삭제 실행 관리자의 개인 ws 로 흡수**.
     * 개인 ws 를 남기면 같은 GitHub 핸들이 해제·재사용될 때 다음 사람이 이전 사람의 비공개 flow 를 통째로 물려받는다.
     */
    @Transactional
    fun purgeUser(username: String) {
        memberRepo.findByUsername(username).forEach { memberRepo.delete(it) }
        wsRepo.findByTenantIdAndKindAndOwnerUsername(tenant(), Workspace.KIND_PERSONAL, username).ifPresent { pws ->
            val target = ensurePersonal(currentUsername())?.id
            flowRepo.reassignWorkspace(pws.id, target)
            folderRepo.reassignWorkspace(pws.id, target)
            mockRepo.reassignWorkspace(pws.id, target)
            memberRepo.deleteByWorkspaceId(pws.id)
            wsRepo.delete(pws)
        }
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
        val ws = wsRepo.findByIdAndTenantId(workspaceId, tenant()).orElseThrow { NotFoundException.of("Workspace", workspaceId) }
        if (ws.kind == Workspace.KIND_PERSONAL) throw BadRequestException("개인 워크스페이스에는 멤버를 추가할 수 없습니다.")
        val u = username.trim().lowercase()
        if (u.isEmpty()) throw BadRequestException("사용자명을 입력하세요.")
        // 예약 계정 금지 — 'guest' 를 멤버로 넣으면 github 모드의 모든 익명 방문자가 그 팀 롤을 얻는다
        if (u == GUEST || u == DEV_USER) throw BadRequestException("예약된 계정명은 멤버로 추가할 수 없습니다: $u")
        if (role !in setOf(WorkspaceMember.ROLE_OWNER, WorkspaceMember.ROLE_EDITOR, WorkspaceMember.ROLE_VIEWER)) {
            throw BadRequestException("role 은 OWNER/EDITOR/VIEWER 중 하나여야 합니다.")
        }
        val existing = memberRepo.findByWorkspaceIdAndUsername(workspaceId, u).orElse(null)
        if (existing != null) {
            // 마지막 OWNER 강등 방지 — removeMember 와 동일 보호(단독 OWNER 가 자신을 VIEWER 로 바꿔 팀이 잠기는 사고)
            if (existing.role == WorkspaceMember.ROLE_OWNER && role != WorkspaceMember.ROLE_OWNER &&
                memberRepo.findByWorkspaceIdOrderByCreatedAtAsc(workspaceId).count { it.role == WorkspaceMember.ROLE_OWNER } <= 1
            ) {
                throw BadRequestException("마지막 OWNER 는 강등할 수 없습니다 — 먼저 다른 OWNER 를 지정하세요.")
            }
            existing.role = role
            memberRepo.save(existing)
        } else {
            memberRepo.save(WorkspaceMember.of(workspaceId, u, role))
        }
        // 사용자 레지스트리에도 등록(관리 화면 목록) — 미로그인 사용자면 PENDING(팀 접근은 멤버십으로 이미 가능,
        // 전역 승인(개인 ws·AI)은 별도 — 팀 OWNER 의 초대가 곧 전역 승인이 되지 않게 분리)
        userRepo.findByTenantIdAndUsername(tenant(), u).orElseGet { userRepo.save(AppUser.of(tenant(), u, defaultStatus(u))) }
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
