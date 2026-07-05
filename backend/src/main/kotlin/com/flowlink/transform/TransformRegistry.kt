package com.flowlink.transform

import org.slf4j.LoggerFactory
import org.springframework.beans.factory.annotation.Value
import org.springframework.stereotype.Component
import java.net.URL
import java.net.URLClassLoader
import java.nio.file.Files
import java.nio.file.Path
import java.util.Optional
import java.util.ServiceLoader
import java.util.concurrent.ConcurrentHashMap

/**
 * 변환 레지스트리 — 내장 변환 + 플러그인 디렉토리의 JAR(ServiceLoader)을 보유한다.
 * (신뢰 JAR 전용 — 샌드박스 없음. 관리자만 업로드)
 */
@Component
class TransformRegistry(@Value("\${flowlink.plugins.dir:plugins}") dir: String) {

    private val byId: MutableMap<String, FlowTransform> = ConcurrentHashMap()
    private val pluginDir: Path = Path.of(dir)

    init {
        reload()
    }

    /** 내장 + 플러그인을 다시 스캔해 등록. (JAR 업로드 후 호출) */
    @Synchronized
    final fun reload() {
        val next = LinkedHashMap<String, FlowTransform>()
        for (t in BuiltinTransforms.all()) {
            next[t.id()] = t
        }
        val pluginCount = loadPlugins(next)
        byId.clear()
        byId.putAll(next)
        log.info(
            "변환 레지스트리 로드: 내장 {}, 플러그인 {} (총 {})",
            BuiltinTransforms.all().size, pluginCount, byId.size
        )
    }

    private fun loadPlugins(map: MutableMap<String, FlowTransform>): Int {
        if (!Files.isDirectory(pluginDir)) {
            return 0
        }
        var count = 0
        try {
            Files.list(pluginDir).use { stream ->
                val jars = ArrayList<URL>()
                for (p in stream.filter { it.toString().lowercase().endsWith(".jar") }.toList()) {
                    jars.add(p.toUri().toURL())
                }
                if (jars.isEmpty()) {
                    return 0
                }
                val cl = URLClassLoader(jars.toTypedArray(), javaClass.classLoader)
                for (t in ServiceLoader.load(FlowTransform::class.java, cl)) {
                    map[t.id()] = t // 플러그인이 내장을 덮어쓸 수 있음
                    count++
                }
            }
        } catch (e: Exception) {
            log.warn("플러그인 로드 실패: {}", e.message)
        }
        return count
    }

    fun get(id: String): Optional<FlowTransform> = Optional.ofNullable(byId[id])

    fun list(): List<FlowTransform> = ArrayList(byId.values)

    companion object {
        private val log = LoggerFactory.getLogger(TransformRegistry::class.java)
    }
}
