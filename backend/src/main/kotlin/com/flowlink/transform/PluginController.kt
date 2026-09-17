package com.flowlink.transform

import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import java.nio.file.Files
import java.nio.file.Path

/**
 * JAR 플러그인 파일 목록(jar-enabled 일 때만 의미). **업로드 API 는 제거됨** — JAR 은 운영자가 서버 디렉터리에 배치하고
 * `flowlink.plugins.jar-enabled=true` 로 켠다(전권 바이너리 예외 경로). 일반 플러그인은 스크립트(/api/v1/plugins/scripts).
 */
@RestController
@RequestMapping("/api/v1/plugins")
class PluginController(private val props: com.flowlink.plugin.PluginsProperties) {
    @GetMapping
    fun list(): List<String> {
        val dir = Path.of(props.dir)
        if (!props.jarEnabled || !Files.isDirectory(dir)) return listOf()
        return Files.list(dir).use { s -> s.filter { it.toString().lowercase().endsWith(".jar") }.map { it.fileName.toString() }.sorted().toList() }
    }
}

data class CodecView(val id: String, val label: String, val layer: String, val params: List<FlowTransform.TransformParam>)

/** 별도 클래스 — PluginController 는 클래스 레벨 @RequestMapping("/api/v1/plugins") 이라 절대경로 매핑 불가. */
@RestController
class CodecController(private val registry: TransformRegistry) {
    @GetMapping("/api/v1/codecs")
    fun codecs(): List<CodecView> = registry.codecs().map {
        CodecView(it.id(), it.label(), if (it is com.flowlink.codec.MessageCodec) "message" else "field", it.params())
    }
}
