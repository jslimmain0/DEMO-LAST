package com.flowlink.transform;

import com.flowlink.common.error.BadRequestException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.List;
import java.util.stream.Stream;

/**
 * 변환 플러그인 JAR 업로드/조회.
 *
 * <p><b>보안</b>: 신뢰 JAR 전용 — 샌드박스 없음. 업로드된 JAR은 전체 권한으로 실행되므로
 * 운영에서는 이 엔드포인트를 관리자 권한으로 제한해야 한다(현재 permitAll, 후속 RBAC 게이트).
 */
@RestController
@RequestMapping("/api/v1/plugins")
public class PluginController {

    private static final Logger log = LoggerFactory.getLogger(PluginController.class);

    private final Path dir;
    private final TransformRegistry registry;

    public PluginController(@Value("${flowlink.plugins.dir:plugins}") String dir, TransformRegistry registry) {
        this.dir = Path.of(dir);
        this.registry = registry;
    }

    @GetMapping
    public List<String> list() throws IOException {
        if (!Files.isDirectory(dir)) {
            return List.of();
        }
        try (Stream<Path> s = Files.list(dir)) {
            return s.filter(p -> p.toString().toLowerCase().endsWith(".jar"))
                    .map(p -> p.getFileName().toString())
                    .sorted()
                    .toList();
        }
    }

    @PostMapping(consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public List<String> upload(@RequestParam("file") MultipartFile file) throws IOException {
        String fn = file.getOriginalFilename();
        if (fn == null || !fn.toLowerCase().endsWith(".jar")) {
            throw new BadRequestException(".jar 파일만 업로드할 수 있습니다.");
        }
        String safe = Path.of(fn).getFileName().toString().replaceAll("[^A-Za-z0-9._-]", "_");
        Files.createDirectories(dir);
        Path target = dir.resolve(safe);
        try (InputStream in = file.getInputStream()) {
            Files.copy(in, target, StandardCopyOption.REPLACE_EXISTING);
        }
        registry.reload();
        log.warn("플러그인 JAR 업로드(신뢰 전제, 샌드박스 없음): {}", safe);
        return registry.list().stream().map(FlowTransform::id).toList();
    }
}
