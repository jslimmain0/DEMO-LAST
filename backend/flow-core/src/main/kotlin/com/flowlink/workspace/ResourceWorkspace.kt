package com.flowlink.workspace

import com.flowlink.common.error.ForbiddenException
import org.springframework.stereotype.Component
import java.util.UUID

/** 같은 이름의 환경·시크릿·전문·플러그인도 공간이 다르면 별개다. 런타임 조회는 이미 승인된 작업의 공간을 받는다. */
@Component
class ResourceWorkspace(private val workspace: WorkspaceService) : com.flowlink.transform.TransformScope {
    override fun key(id: UUID?): String {
        val actual = id ?: if (workspace.localRuntime) workspace.resolveId(null) else null
        if (!workspace.supportsWorkspace(actual)) throw ForbiddenException("이 에이전트에서 사용할 수 없는 워크스페이스입니다.")
        return actual?.toString() ?: WorkspaceService.PUBLIC_ID
    }

    fun read(raw: String?): String = workspace.resolveId(raw).let {
        workspace.requireRead(workspace.currentUsername(), it)
        key(it)
    }

    fun write(raw: String?): String = workspace.resolveId(raw).let {
        if (!workspace.isApproved(workspace.currentUsername())) throw ForbiddenException("자원 변경은 가입 승인 후 가능합니다.")
        workspace.requireWrite(workspace.currentUsername(), it)
        key(it)
    }

    fun requireRead(key: String) { read(key) }
    fun requireWrite(key: String) { write(key) }

    companion object {
        fun id(key: String): UUID? = if (key == WorkspaceService.PUBLIC_ID) null else UUID.fromString(key)
    }
}
