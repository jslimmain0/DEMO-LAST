package com.flowlink.transform

import com.flowlink.codec.CodecPlugin
import com.flowlink.plugin.PluginsProperties
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Component
import java.net.URLClassLoader
import java.nio.file.Files
import java.nio.file.Path
import java.util.Optional
import java.util.ServiceLoader
import java.util.concurrent.ConcurrentHashMap

/** 승인된 스크립트 플러그인을 SPI 구현체(FlowTransform | CodecPlugin)로 넘겨주는 소스 — DB 로더가 구현(PluginScriptService). */
fun interface ScriptPluginLoader {
    fun loadApproved(): List<Any>
    companion object { @JvmField val NONE = ScriptPluginLoader { emptyList() } }
}

/**
 * 변환/코덱 레지스트리 — 스크립트 플러그인(DB 승인본) + (jar-enabled 일 때만) 플러그인 디렉터리의 JAR(ServiceLoader).
 * JAR 은 신뢰 전제·샌드박스 없음이라 기본 비활성. 같은 id 는 나중 로드가 덮는다(스크립트가 JAR 뒤에 로드 → 스크립트 우선).
 */
@Component
class TransformRegistry(
    private val props: PluginsProperties,
    private val scripts: ScriptPluginLoader = ScriptPluginLoader.NONE,
) {
    private val byId: MutableMap<String, FlowTransform> = ConcurrentHashMap()
    private val codecById: MutableMap<String, CodecPlugin> = ConcurrentHashMap()
    private val pluginDir: Path = Path.of(props.dir)
    @Volatile private var loader: URLClassLoader? = null

    init { reload() }

    /** 다시 스캔해 등록(스크립트 승인/삭제·JAR 배치 후). 이전 URLClassLoader 는 닫는다(Windows JAR 잠김 방지). */
    @Synchronized
    fun reload() {
        val next = LinkedHashMap<String, FlowTransform>()
        val nextCodecs = LinkedHashMap<String, CodecPlugin>()
        val jars = if (props.jarEnabled) loadJars(next, nextCodecs) else warnSkippedJars()
        var scriptCount = 0
        for (p in scripts.loadApproved()) {
            when (p) {
                is FlowTransform -> { next[p.id()] = p; scriptCount++ }
                is CodecPlugin -> { nextCodecs[p.id()] = p; scriptCount++ }
            }
        }
        byId.clear(); byId.putAll(next)
        codecById.clear(); codecById.putAll(nextCodecs)
        log.info("플러그인 로드 — JAR {}개, 스크립트 {}개 → 변환 {}개, 코덱 {}개", jars, scriptCount, byId.size, codecById.size)
    }

    private fun jarFiles(): List<Path> =
        if (!Files.isDirectory(pluginDir)) emptyList()
        else Files.list(pluginDir).use { s -> s.filter { it.toString().lowercase().endsWith(".jar") }.sorted().toList() }

    private fun warnSkippedJars(): Int {
        val jars = jarFiles()
        if (jars.isNotEmpty()) log.warn("플러그인 JAR {}개가 있으나 flowlink.plugins.jar-enabled=false — 로드하지 않음: {}", jars.size, jars.map { it.fileName.toString() })
        return 0
    }

    /** JAR 하나씩 별도 로더로 — 깨진 JAR 이 나머지를 못 죽인다. 반환: 성공한 JAR 수. */
    private fun loadJars(map: MutableMap<String, FlowTransform>, codecs: MutableMap<String, CodecPlugin>): Int {
        loader?.let { runCatching { it.close() } }
        val jars = jarFiles()
        if (jars.isEmpty()) return 0
        var ok = 0
        val cl = URLClassLoader(jars.map { it.toUri().toURL() }.toTypedArray(), javaClass.classLoader)
        loader = cl
        for (jar in jars) {
            try {
                val one = URLClassLoader(arrayOf(jar.toUri().toURL()), cl)
                for (t in ServiceLoader.load(FlowTransform::class.java, one)) map[t.id()] = t
                for (c in ServiceLoader.load(CodecPlugin::class.java, one)) codecs[c.id()] = c
                ok++
            } catch (e: Throwable) { // ServiceConfigurationError 는 Error 계열
                log.warn("플러그인 JAR 로드 실패(건너뜀): {} — {}", jar.fileName, e.message ?: e.toString())
            }
        }
        return ok
    }

    fun get(id: String): Optional<FlowTransform> = Optional.ofNullable(byId[id])
    fun list(): List<FlowTransform> = ArrayList(byId.values)
    fun codec(id: String): CodecPlugin? = codecById[id]
    fun codecs(): List<CodecPlugin> = ArrayList(codecById.values)

    companion object { private val log = LoggerFactory.getLogger(TransformRegistry::class.java) }
}
