package com.flowlink.transform

import com.flowlink.common.error.BadRequestException
import org.slf4j.LoggerFactory
import org.springframework.beans.factory.annotation.Value
import org.springframework.http.MediaType
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.multipart.MultipartFile
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption

/**
 * 변환 플러그인 JAR 업로드/조회.
 *
 * **보안**: 신뢰 JAR 전용 — 샌드박스 없음. 업로드된 JAR은 전체 권한으로 실행된다.
 * OIDC 모드(SaaS P1)에서는 plugins 하위 경로를 전역 `platform-admin` 롤로 게이트한다(SecurityConfig).
 * github/dev 모드에서는 업로드를 **워크스페이스 관리자(ADMIN)** 로 게이트 — 게스트/승인 대기 계정의
 * 무인증 JAR 업로드(=RCE, 적대 리뷰 [H])를 서비스 레벨에서 봉인(dev 모드의 'dev' 는 항상 관리자라 로컬 무마찰).
 */
@RestController
@RequestMapping("/api/v1/plugins")
class PluginController(
    @Value("\${flowlink.plugins.dir:plugins}") dir: String,
    private val registry: TransformRegistry,
    private val workspace: com.flowlink.workspace.WorkspaceService,
) {
    private val dir: Path = Path.of(dir)

    @GetMapping
    fun list(): List<String> {
        if (!Files.isDirectory(dir)) {
            return listOf()
        }
        return Files.list(dir).use { s ->
            s.filter { it.toString().lowercase().endsWith(".jar") }
                .map { it.fileName.toString() }
                .sorted()
                .toList()
        }
    }

    @PostMapping(consumes = [MediaType.MULTIPART_FORM_DATA_VALUE])
    fun upload(@RequestParam("file") file: MultipartFile): List<String> {
        if (!workspace.isAdmin(workspace.currentUsername())) {
            throw com.flowlink.common.error.ForbiddenException("플러그인 업로드는 관리자만 가능합니다(JAR 는 전체 권한으로 실행됨).")
        }
        val fn = file.originalFilename
        if (fn == null || !fn.lowercase().endsWith(".jar")) {
            throw BadRequestException(".jar 파일만 업로드할 수 있습니다.")
        }
        val safe = Path.of(fn).fileName.toString().replace(Regex("[^A-Za-z0-9._-]"), "_")
        Files.createDirectories(dir)
        val target = dir.resolve(safe)
        file.inputStream.use { input ->
            Files.copy(input, target, StandardCopyOption.REPLACE_EXISTING)
        }
        registry.reload()
        log.warn("플러그인 JAR 업로드(신뢰 전제, 샌드박스 없음): {}", safe)
        return registry.list().map { it.id() }
    }

    companion object {
        private val log = LoggerFactory.getLogger(PluginController::class.java)
    }
}
