package com.flowlink.transform;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.ServiceLoader;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Stream;

/**
 * 변환 레지스트리 — 내장 변환 + 플러그인 디렉토리의 JAR(ServiceLoader)을 보유한다.
 * (신뢰 JAR 전용 — 샌드박스 없음. 관리자만 업로드)
 */
@Component
public class TransformRegistry {

    private static final Logger log = LoggerFactory.getLogger(TransformRegistry.class);

    private final Map<String, FlowTransform> byId = new ConcurrentHashMap<>();
    private final Path pluginDir;

    public TransformRegistry(@Value("${flowlink.plugins.dir:plugins}") String dir) {
        this.pluginDir = Path.of(dir);
        reload();
    }

    /** 내장 + 플러그인을 다시 스캔해 등록. (JAR 업로드 후 호출) */
    public final synchronized void reload() {
        Map<String, FlowTransform> next = new LinkedHashMap<>();
        for (FlowTransform t : BuiltinTransforms.all()) {
            next.put(t.id(), t);
        }
        int pluginCount = loadPlugins(next);
        byId.clear();
        byId.putAll(next);
        log.info("변환 레지스트리 로드: 내장 {}, 플러그인 {} (총 {})",
                BuiltinTransforms.all().size(), pluginCount, byId.size());
    }

    private int loadPlugins(Map<String, FlowTransform> map) {
        if (!Files.isDirectory(pluginDir)) {
            return 0;
        }
        int count = 0;
        try (Stream<Path> stream = Files.list(pluginDir)) {
            List<URL> jars = new ArrayList<>();
            for (Path p : stream.filter(p -> p.toString().toLowerCase().endsWith(".jar")).toList()) {
                jars.add(p.toUri().toURL());
            }
            if (jars.isEmpty()) {
                return 0;
            }
            URLClassLoader cl = new URLClassLoader(jars.toArray(URL[]::new), getClass().getClassLoader());
            for (FlowTransform t : ServiceLoader.load(FlowTransform.class, cl)) {
                map.put(t.id(), t); // 플러그인이 내장을 덮어쓸 수 있음
                count++;
            }
        } catch (Exception e) {
            log.warn("플러그인 로드 실패: {}", e.getMessage());
        }
        return count;
    }

    public Optional<FlowTransform> get(String id) {
        return Optional.ofNullable(byId.get(id));
    }

    public List<FlowTransform> list() {
        return new ArrayList<>(byId.values());
    }
}
