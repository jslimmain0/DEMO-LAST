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
data class ScopedPlugin(val tenantId: String, val workspaceKey: String, val plugin: Any, val publishedSource: String? = null)

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
    private val resourceWorkspace: TransformScope? = null,
) {
    private val byId: MutableMap<String, FlowTransform> = ConcurrentHashMap()
    private val codecById: MutableMap<String, CodecPlugin> = ConcurrentHashMap()
    private val fingerprints: MutableMap<String, String> = ConcurrentHashMap()
    private val pluginDir: Path = Path.of(props.dir)
    @Volatile private var loaders: List<URLClassLoader> = emptyList()

    init { reload() }

    /** 다시 스캔해 등록(스크립트 승인/삭제·JAR 배치 후). 이전 URLClassLoader 는 닫는다(Windows JAR 잠김 방지). */
    @Synchronized
    fun reload() {
        // DB/컴파일 단계가 통째로 죽으면(예: DB 다운) 이전 등록·JAR 로더를 그대로 둔다 — 빈 레지스트리로 서빙하지 않게.
        val enabled = resourceWorkspace?.pluginsEnabled != false
        val approved = try { if (enabled) scripts.loadApproved() else emptyList() } catch (e: Exception) { log.error("스크립트 플러그인 로드 실패 — 이전 등록 유지", e); return }
        closeLoaders()
        val next = LinkedHashMap<String, FlowTransform>()
        val nextCodecs = LinkedHashMap<String, CodecPlugin>()
        val nextHashes = LinkedHashMap<String, String>()
        val jars = if (enabled && props.jarEnabled) loadJars(next, nextCodecs, nextHashes) else if (enabled) warnSkippedJars() else 0
        var scriptCount = 0
        for (entry in approved) {
            val p = if (entry is ScopedPlugin) entry.plugin else entry
            fun key(id: String) = if (entry is ScopedPlugin) "${entry.tenantId}|${entry.workspaceKey}|$id" else id
            when (p) {
                is FlowTransform -> { next[key(p.id())] = p; nextHashes[key(p.id())] = pluginHash(entry, p); scriptCount++ }
                is CodecPlugin -> { nextCodecs[key(p.id())] = p; nextHashes[key(p.id())] = pluginHash(entry, p); scriptCount++ }
            }
        }
        byId.clear(); byId.putAll(next)
        codecById.clear(); codecById.putAll(nextCodecs)
        fingerprints.clear(); fingerprints.putAll(nextHashes)
        log.info("플러그인 로드 — JAR {}개, 스크립트 {}개 → 변환 {}개, 코덱 {}개", jars, scriptCount, byId.size, codecById.size)
    }

    private fun jarFiles(): List<Path> =
        if (!Files.isDirectory(pluginDir)) emptyList()
        else Files.list(pluginDir).use { s -> s.filter { it.toString().lowercase().endsWith(".jar") }.sorted().toList() }

    private fun closeLoaders() {
        for (loader in loaders) runCatching { loader.close() }
        loaders = emptyList()
    }

    private fun warnSkippedJars(): Int {
        val jars = jarFiles()
        if (jars.isNotEmpty()) log.warn("플러그인 JAR {}개가 있으나 flowlink.plugins.jar-enabled=false — 로드하지 않음: {}", jars.size, jars.map { it.fileName.toString() })
        return 0
    }

    /** JAR 하나씩 별도 로더로 — 깨진 JAR 이 나머지를 못 죽인다. 반환: 성공한 JAR 수. */
    private fun loadJars(map: MutableMap<String, FlowTransform>, codecs: MutableMap<String, CodecPlugin>, hashes: MutableMap<String, String>): Int {
        val jars = jarFiles()
        if (jars.isEmpty()) return 0
        var ok = 0
        val loadersToKeep = mutableListOf<URLClassLoader>()
        // 각 JAR은 독립적인 로더로 로드 - 깨진 JAR이 다른 JAR을 방해하지 않도록
        for (jar in jars) {
            try {
                val one = URLClassLoader(arrayOf(jar.toUri().toURL()), javaClass.classLoader)
                loadersToKeep.add(one)
                val artifactHash = sha256(Files.readAllBytes(jar))
                for (t in ServiceLoader.load(FlowTransform::class.java, one)) { map[t.id()] = t; hashes[t.id()] = artifactHash }
                for (c in ServiceLoader.load(CodecPlugin::class.java, one)) { codecs[c.id()] = c; hashes[c.id()] = artifactHash }
                ok++
            } catch (e: Throwable) { // ServiceConfigurationError 는 Error 계열
                log.warn("플러그인 JAR 로드 실패(건너뜀): {} — {}", jar.fileName, e.message ?: e.toString())
            }
        }
        loaders = loadersToKeep
        return ok
    }

    private fun sha256(bytes: ByteArray): String = java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes))
    private fun pluginHash(entry: Any, plugin: Any): String {
        if (entry is ScopedPlugin && entry.publishedSource != null) return sha256(entry.publishedSource.toByteArray(Charsets.UTF_8))
        val cls = plugin.javaClass
        val bytes = cls.getResourceAsStream("/" + cls.name.replace('.', '/') + ".class")?.use { it.readAllBytes() } ?: byteArrayOf()
        return sha256(cls.name.toByteArray(Charsets.UTF_8) + bytes)
    }

    fun fingerprint(id: String, workspaceId: java.util.UUID? = null, tenantId: String = com.flowlink.common.tenant.TenantContext.getTenantId()): String? =
        fingerprints[prefix(workspaceId, tenantId) + id] ?: fingerprints[id]

    private fun prefix(workspaceId: java.util.UUID?, tenantId: String): String = "$tenantId|${resourceWorkspace?.key(workspaceId) ?: workspaceId?.toString() ?: "public"}|"
    // 운영자가 설치한 JAR은 에이전트 공통 의존성. 승인 스크립트는 테넌트와 공간이 일치해야 한다.
    fun get(id: String, workspaceId: java.util.UUID? = null, tenantId: String = com.flowlink.common.tenant.TenantContext.getTenantId()): Optional<FlowTransform> =
        Optional.ofNullable(byId[prefix(workspaceId, tenantId) + id] ?: byId[id])
    fun list(workspaceId: java.util.UUID? = null, tenantId: String = com.flowlink.common.tenant.TenantContext.getTenantId()): List<FlowTransform> = visible(byId, prefix(workspaceId, tenantId))
    fun codec(id: String, workspaceId: java.util.UUID? = null, tenantId: String = com.flowlink.common.tenant.TenantContext.getTenantId()): CodecPlugin? = codecById[prefix(workspaceId, tenantId) + id] ?: codecById[id]
    fun codecs(workspaceId: java.util.UUID? = null, tenantId: String = com.flowlink.common.tenant.TenantContext.getTenantId()): List<CodecPlugin> = visible(codecById, prefix(workspaceId, tenantId))
    private fun <T> visible(map: Map<String, T>, prefix: String): List<T> {
        val result = LinkedHashMap<String, T>()
        map.filterKeys { '|' !in it }.forEach { (k, v) -> result[k] = v }
        map.filterKeys { it.startsWith(prefix) }.forEach { (k, v) -> result[k.removePrefix(prefix)] = v }
        return result.values.toList()
    }

    companion object { private val log = LoggerFactory.getLogger(TransformRegistry::class.java) }
}
