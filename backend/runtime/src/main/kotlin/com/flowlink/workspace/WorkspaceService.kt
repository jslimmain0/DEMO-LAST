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
import org.springframework.core.env.Environment
import org.springframework.core.env.Profiles
import org.springframework.boot.context.event.ApplicationReadyEvent
import org.springframework.context.event.EventListener
import org.springframework.core.annotation.Order
import java.time.Instant
import java.util.UUID

/**
 * 워크스페이스(폴더 위 최상위 그룹) + 롤 기반 접근.
 *  - 공용: DB 행 없는 가상 스코프(workspace_id=null) — 모두(게스트 포함) EDITOR. 기존 데이터/동작 100% 호환.
 *  - 개인: desktop 프로파일의 PC H2에만 생성. 서버에는 생성·접근하지 않는다.
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
    private val environment: Environment,
    private val environmentRepo: com.flowlink.core.repository.EnvironmentRepository,
    private val secretRepo: com.flowlink.core.repository.SecretRepository,
    private val protocolRepo: com.flowlink.core.repository.ProtocolRepository,
    private val scriptRepo: com.flowlink.core.repository.PluginScriptRepository,
    private val executionRepo: com.flowlink.core.repository.ExecutionRepository,
) {
    companion object {
        const val PUBLIC_ID = "public" // 가상 공용 워크스페이스 id(API 표현)
        const val GUEST = "guest"
        const val DEV_USER = "dev"
        private val log = org.slf4j.LoggerFactory.getLogger(WorkspaceService::class.java)
    }

    private fun tenant(): String = TenantContext.SHARED_FLOW_TENANT
    val localRuntime: Boolean get() = environment.acceptsProfiles(Profiles.of("desktop"))

    /** 자동 트리거·외부 Mock도 관리자 권한과 무관하게 실행 위치 경계를 지킨다. */
    fun supportsWorkspace(id: UUID?): Boolean {
        if (id == null) return !localRuntime
        val ws = wsRepo.findByIdAndTenantId(id, tenant()).orElse(null) ?: return false
        return if (localRuntime) ws.kind == Workspace.KIND_PERSONAL && ws.ownerUsername == DEV_USER
            else ws.kind == Workspace.KIND_TEAM
    }

    /** 기존 PC의 미분류 데이터도 같은 H2의 개인 공간으로만 이관한다. 서버에는 적용하지 않는다. */
    @EventListener(ApplicationReadyEvent::class)
    @Order(0)
    @Transactional
    fun initializeLocalWorkspace() {
        if (!localRuntime) return
        val personal = ensurePersonal(DEV_USER) ?: error("개인 워크스페이스 초기화 실패")
        flowRepo.reassignWorkspace(null, personal.id)
        folderRepo.reassignWorkspace(null, personal.id)
        mockRepo.reassignWorkspace(null, personal.id)
    }

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
    // 롤 변경(putUser)·삭제 시 즉시 무효화. dev 판정은 캐시 불필요(메모리 비교).
    private val adminCache = java.util.concurrent.ConcurrentHashMap<String, Pair<Long, Boolean>>()

    fun invalidateRoleCache(username: String) { adminCache.remove(username.lowercase()); adminSeen = false }

    @Transactional
    fun isAdmin(username: String): Boolean {
        if (username == DEV_USER) return true // dev 모드 = 로컬 단독 사용 — 전권
        val now = System.currentTimeMillis()
        adminCache[username]?.let { if (now - it.first < 5_000) return it.second }
        val v = userRepo.findByTenantIdAndUsername(tenant(), username)
            .map { it.globalRole == AppUser.ROLE_ADMIN }.orElse(false)
        adminCache[username] = now to v
        return v
    }

    /**
     * 사용자 자동 등록/최근 활동 갱신 — 로그인(GithubAuthService.complete)·활동(listMine) 시 호출, 등록된 행을 돌려준다(게스트는 null).
     * **처음 관측되는 사용자는 PENDING(가입 신청)** → 관리 콘솔에서 승인. 단 테넌트에 ADMIN 이 아직 없으면 **첫 사용자를 ADMIN+APPROVED 로 부트스트랩**
     * (env 관리자 목록이 없으므로 유일한 최초 관리자 생성 경로). 동시 첫 로그인 레이스는 무시한다(내부망 도구).
     */
    @Transactional
    fun touchUser(username: String): AppUser? {
        if (!isAuthenticated(username)) return null
        val u = userRepo.findByTenantIdAndUsername(tenant(), username).orElseGet {
            log.info("가입 신청 등록: {} ({})", username, defaultStatus(username))
            userRepo.save(AppUser.of(tenant(), username, defaultStatus(username)))
        }
        // 최초 관리자 부트스트랩 — 테넌트에 ADMIN 이 한 명도 없으면 지금 로그인한 사용자(기존 DB 의 사용자 포함)를 ADMIN+APPROVED 로.
        // ponytail: 관리자가 한 번 확인되면 exists 조회를 건너뛴다. 동시 첫 로그인 레이스는 무시(내부망 도구).
        if (username != DEV_USER && u.globalRole != AppUser.ROLE_ADMIN && !adminExists()) {
            u.globalRole = AppUser.ROLE_ADMIN; u.status = AppUser.STATUS_APPROVED; adminSeen = true
            invalidateRoleCache(username)
            log.info("최초 사용자 관리자 부트스트랩: {}", username)
        }
        u.lastSeenAt = Instant.now()
        return userRepo.save(u)
    }

    @Volatile private var adminSeen = false
    private fun adminExists(): Boolean {
        if (!adminSeen) adminSeen = userRepo.existsByTenantIdAndGlobalRole(tenant(), AppUser.ROLE_ADMIN)
        return adminSeen
    }

    /** 신규 등록 기본 상태 — dev 는 APPROVED, 그 외 PENDING(가입 신청). */
    fun defaultStatus(username: String): String =
        if (username == DEV_USER) AppUser.STATUS_APPROVED else AppUser.STATUS_PENDING

    /** 개발 서버 전용 고정 모킹 계정. 기존 ADMIN 행이 있어도 승인 대기에 막히지 않는다. */
    @Transactional
    fun approveLabUser(username: String) {
        check(!localRuntime && environment.acceptsProfiles(Profiles.of("agent-lab")) && username == "lab-admin")
        val user = touchUser(username) ?: error("모킹 계정 생성 실패")
        if (user.effectiveStatus() == AppUser.STATUS_BLOCKED) throw ForbiddenException("차단된 테스트 계정입니다.")
        user.status = AppUser.STATUS_APPROVED; user.globalRole = AppUser.ROLE_ADMIN
        userRepo.save(user); invalidateRoleCache(username)
    }

    /**
     * 가입 승인 여부 — **승인된 사용자만** 개인 워크스페이스·팀 생성·AI 를 쓴다(팀 접근은 멤버십으로 별도 판정).
     * 관리자·dev 는 항상 승인. 레거시 행(status=null)도 승인 간주.
     */
    @Transactional
    fun isApproved(username: String): Boolean {
        if (!isAuthenticated(username)) return false
        // 차단이 DB-ADMIN 보다 우선 — 차단해도 관리자 롤로 AI 가 살아있지 않게(dev 만 예외).
        val row = userRepo.findByTenantIdAndUsername(tenant(), username).orElse(null)
        if (row?.effectiveStatus() == AppUser.STATUS_BLOCKED && username != DEV_USER) return false
        if (username == DEV_USER || isAdmin(username)) return true
        return row?.effectiveStatus() == AppUser.STATUS_APPROVED
    }

    /** 개인 워크스페이스 보장(없으면 생성) — **승인된 사용자만**(가입 신청 중에는 공용만 사용). */
    @Transactional
    fun ensurePersonal(username: String): Workspace? {
        if (!localRuntime || username != DEV_USER) return null
        // 동시 첫 로그인 레이스는 V16 유니크 인덱스가 이중 생성을 막는다 — 진 쪽 요청은 1회 실패 후
        // 다음 요청에서 이긴 행을 찾는다(트랜잭션 rollback-only 때문에 같은 tx 내 catch-재조회는 불가).
        return wsRepo.findByTenantIdAndKindAndOwnerUsername(tenant(), Workspace.KIND_PERSONAL, username)
            .orElseGet { wsRepo.save(Workspace.personal(tenant(), username, "개인 · 내 PC")) }
    }

    /** 워크스페이스에서의 내 롤 — null(공용)=EDITOR(모두), 개인=소유자 OWNER, 팀=멤버십. 관리자=OWNER. 접근 불가면 null. */
    @Transactional
    fun roleFor(username: String, workspaceId: UUID?): String? {
        if (workspaceId == null) return if (localRuntime) null else WorkspaceMember.ROLE_EDITOR
        // 존재 확인을 admin 단축 경로보다 먼저 — 없는 ws id 에 관리자가 OWNER 로 판정되면
        // 존재하지 않는 워크스페이스에 flow 를 배정해 고아 데이터를 만들 수 있다.
        val ws = wsRepo.findByIdAndTenantId(workspaceId, tenant()).orElse(null) ?: return null
        // 관리자도 실행 위치 경계를 우회할 수 없다.
        if (localRuntime) return if (ws.kind == Workspace.KIND_PERSONAL && ws.ownerUsername == DEV_USER && username == DEV_USER)
            WorkspaceMember.ROLE_OWNER else null
        if (ws.kind != Workspace.KIND_TEAM) return null
        if (isAdmin(username)) return WorkspaceMember.ROLE_OWNER
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
        if (localRuntime) {
            if (t == PUBLIC_ID) throw ForbiddenException("공용 워크스페이스는 서버에서 사용하세요.")
            if (t.isNullOrEmpty() || t == "local") return ensurePersonal(DEV_USER)?.id
                ?: throw ForbiddenException("개인 워크스페이스가 준비되지 않았습니다.")
        } else if (t == "local") {
            throw ForbiddenException("개인 워크스페이스는 PC의 H2 저장소에서 사용하세요.")
        }
        if (t.isNullOrEmpty() || t == PUBLIC_ID) return null
        return try { UUID.fromString(t) } catch (e: IllegalArgumentException) {
            throw BadRequestException("workspaceId 가 올바르지 않습니다: $t")
        }
    }

    /**
     * 테넌트의 **모든** 워크스페이스(공용 제외) — 접근 권한과 무관. Mock 서버 현황(fleet)처럼 "다른 팀이 무엇을 띄워 뒀는지"를
     * 이름·개수 수준으로만 보여줄 때 쓴다(내용 접근은 여전히 roleFor 로 판정).
     */
    @Transactional(readOnly = true)
    fun listAll(): List<Workspace> = wsRepo.findByTenantIdOrderByCreatedAtAsc(tenant()).filter {
        if (localRuntime) it.kind == Workspace.KIND_PERSONAL && it.ownerUsername == DEV_USER else it.kind == Workspace.KIND_TEAM
    }

    /** 팀 멤버십 행이 있는가(관리자 우회 없음) — "내 워크스페이스" 그룹핑용(권한 판정은 roleFor). */
    @Transactional(readOnly = true)
    fun isMember(username: String, workspaceId: UUID): Boolean =
        memberRepo.findByWorkspaceIdAndUsername(workspaceId, username).isPresent

    /** 내가 볼 수 있는 워크스페이스 목록 — 공용 + 개인 + 멤버 팀(+관리자는 전체 팀/개인). */
    @Transactional
    fun listMine(): List<WorkspaceView> {
        val me = currentUsername()
        if (localRuntime) {
            val personal = ensurePersonal(DEV_USER) ?: error("개인 워크스페이스 초기화 실패")
            return listOf(WorkspaceView(personal.id.toString(), personal.name, personal.kind, WorkspaceMember.ROLE_OWNER, false))
        }
        touchUser(me)
        val out = ArrayList<WorkspaceView>()
        out.add(WorkspaceView(PUBLIC_ID, "공용", "PUBLIC", WorkspaceMember.ROLE_EDITOR, isAdmin(me)))
        val admin = isAdmin(me)
        if (admin) {
            for (ws in listAll()) {
                out.add(WorkspaceView(ws.id.toString(), ws.name, ws.kind, WorkspaceMember.ROLE_OWNER, true))
            }
        } else {
            for (m in memberRepo.findByUsername(me)) {
                val ws = wsRepo.findByIdAndTenantId(m.workspaceId, tenant()).orElse(null) ?: continue
                // 개인 ws 멤버십 행(비정상 데이터)·자기 개인 ws 중복은 목록에서 제외 — 진입 불가/중복 표시 방지
                if (ws.kind != Workspace.KIND_TEAM) continue
                out.add(WorkspaceView(ws.id.toString(), ws.name, ws.kind, m.role, m.role == WorkspaceMember.ROLE_OWNER))
            }
        }
        return out
    }

    @Transactional
    fun createTeam(name: String): WorkspaceView {
        if (localRuntime) throw ForbiddenException("팀 워크스페이스는 로그인한 서버에서만 만들 수 있습니다.")
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
    fun delete(workspaceId: UUID, moveTo: UUID? = null) {
        if (localRuntime) throw ForbiddenException("개인 워크스페이스는 삭제할 수 없습니다.")
        val me = currentUsername()
        val ws = wsRepo.findByIdAndTenantId(workspaceId, tenant()).orElseThrow { NotFoundException.of("Workspace", workspaceId) }
        requireOwner(me, workspaceId)
        if (executionRepo.countActiveInWorkspace(workspaceId, listOf(com.flowlink.core.domain.ExecutionStatus.RUNNING, com.flowlink.core.domain.ExecutionStatus.WAITING)) > 0)
            throw BadRequestException("실행 중이거나 대기 중인 워크플로를 먼저 종료한 뒤 워크스페이스를 삭제하세요.")
        val key = workspaceId.toString()
        if (environmentRepo.countByTenantIdAndWorkspaceKey(tenant(), key) + secretRepo.countByTenantIdAndWorkspaceKey(tenant(), key) + protocolRepo.countByTenantIdAndWorkspaceKey(tenant(), key) + scriptRepo.countByTenantIdAndWorkspaceKey(tenant(), key) > 0) throw BadRequestException("환경·시크릿·전문·플러그인이 남아 있습니다. 목적지에서 자원을 명시적으로 준비하고 원본 자원을 정리한 후 팀을 삭제하세요.")
        if (moveTo != null) {
            if (moveTo == workspaceId) throw BadRequestException("다른 원격 팀을 선택하세요.")
            val target = wsRepo.findByIdAndTenantId(moveTo, tenant()).orElseThrow { NotFoundException.of("Workspace", moveTo) }
            if (target.kind != Workspace.KIND_TEAM) throw ForbiddenException("원격 팀으로만 이관할 수 있습니다.")
            requireWrite(me, moveTo)
            if (mockRepo.findByTenantIdOrderByUpdatedAtDesc(tenant()).any { it.workspaceId == workspaceId && mockRepo.existsByTenantIdAndWorkspaceKeyAndSlug(tenant(), moveTo.toString(), it.slug) }) throw BadRequestException("이관 대상 팀에 같은 slug의 Mock이 있습니다. 이름 충돌을 먼저 해결하세요.")
            flowRepo.reassignWorkspace(workspaceId, moveTo)
            folderRepo.reassignWorkspace(workspaceId, moveTo)
            mockRepo.reassignWorkspace(workspaceId, moveTo)
        }
        if (flowRepo.countByTenantIdAndWorkspaceId(tenant(), workspaceId) > 0 ||
            folderRepo.findByTenantIdOrderByNameAsc(tenant()).any { it.workspaceId == workspaceId } ||
            mockRepo.countByTenantIdAndWorkspaceId(tenant(), workspaceId) > 0) {
            throw BadRequestException("내용이 있는 팀은 이관할 원격 팀을 선택한 뒤 삭제하세요. 개인·공용 공간으로는 자동 이동하지 않습니다.")
        }
        memberRepo.deleteByWorkspaceId(workspaceId)
        wsRepo.delete(ws)
    }

    /**
     * 원격 사용자 삭제는 팀 멤버십만 제거한다. 데이터가 공용이나 PC로 자동 이동하지 않는다.
     */
    @Transactional
    fun purgeUser(username: String) {
        if (localRuntime) throw ForbiddenException("사용자 관리는 서버에서만 가능합니다.")
        memberRepo.findByUsername(username).forEach { memberRepo.delete(it) }
        // 구 서버 PERSONAL 데이터는 비공개 상태로 보존한다. 공용 승격/PC 이동/핸들 재사용 접근을 허용하지 않는다.
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
