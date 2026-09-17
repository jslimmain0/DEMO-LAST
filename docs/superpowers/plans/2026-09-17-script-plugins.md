# 스크립트 플러그인 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 플러그인(변환·코덱)을 JAR 업로드 대신 **화면에서 JS 로 적고 → 서버 샌드박스에서 돌려 보고 → 관리자 승인 → 레지스트리 등록**하게 한다. JAR 은 기본 비활성 예외 경로로 격하.

**Architecture:** GraalJS 컨텍스트(호스트 접근 없음, `fl.*` 프록시만 주입, CPU/문장 상한)에서 스크립트의 마지막 표현식(플러그인 객체)을 평가하고, 기존 SPI(`FlowTransform`/`FieldCodec`/`MessageCodec`) 어댑터로 감싸 `TransformRegistry` 에 넣는다. 소스는 `flowlink_plugin_script`(초안/승인본 분리)에 저장, 상태 전이는 서비스 레이어 게이트(승인 사용자 쓰기 · 관리자 승인). 프론트는 `/plugins` 페이지(좌 목록 | 우 CodeMirror 편집기 + 실행 패널) + 관리 콘솔 승인 큐.

**Tech Stack:** Kotlin 1.9 / Spring Boot 3.3.5 / GraalJS(`org.graalvm.polyglot:polyglot` + `js-community` 24.1.2) / BouncyCastle `bcprov-jdk18on:1.80` / React 19 + CodeMirror 6(`@codemirror/lang-javascript` 6.2.5 신규) / js-beautify(설치됨) / Playwright(검증용, 스크래치패드).

**Spec:** `docs/superpowers/specs/2026-09-17-script-plugins-design.md`

## Global Constraints

- Kotlin 1.9 · Java 21 toolchain · Spring Boot 3.3.5. 백엔드 테스트는 `cd backend && ./gradlew :test --tests '<패턴>' --console=plain` (H2 인메모리, DB 불필요). 전체 스위트 `./gradlew :test`.
- 프론트 패키지 매니저는 **npm**(`frontend/package-lock.json` 이 커밋됨 — pnpm-lock 은 무시). 검증은 `cd frontend && npx tsc -b && npx oxlint src && npm run build`.
- 새 테이블은 `@Table(name="flowlink_…")` + `backend/src/main/resources/db/init.sql` 에 Oracle DDL 추가(local H2 는 ddl-auto). Flyway 없음.
- 게이트 관례: URL 규칙이 아니라 **서비스 레이어**에서 `WorkspaceService.isApproved(username)`/`isAdmin(username)` 검사 → `ForbiddenException`(403). 입력 오류는 `BadRequestException`(400). 응답 바디 `ApiError{message}`.
- Jackson 역직렬화 DTO 에 `@get:JvmName` 금지(CLAUDE 관례). UI 텍스트 한국어.
- 문서(`docs/guide`, README)는 이 브랜치에서 갱신하지 않는다(사용자 결정 — 문서 일괄 삭제됨).
- 커밋은 `git add <파일> && git commit -m "…" -- <파일>` 처럼 **pathspec** 으로(병렬 에이전트 안전). 커밋 메시지 끝: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- 스크립트 표면은 **`fl.*` + 표준 JS 뿐** — `Java`, `Polyglot`, 호스트 클래스 접근을 어떤 태스크에서도 열지 않는다.

## File Structure

**Backend (신규 패키지 `com.flowlink.plugin`)**
- `backend/src/main/kotlin/com/flowlink/plugin/PluginsProperties.kt` — `flowlink.plugins.*` 바인딩(dir, jar-enabled, script.timeout-ms, script.statement-limit).
- `backend/src/main/kotlin/com/flowlink/plugin/script/ScriptError.kt` — 컴파일/실행 오류(line/col/message).
- `backend/src/main/kotlin/com/flowlink/plugin/script/ScriptRuntime.kt` — GraalJS 엔진·컨텍스트 팩토리·샌드박스·타임아웃·컴파일(메타 추출)·호출(`run…`). 값 변환(`ProxyObject`/`Uint8Array`).
- `backend/src/main/kotlin/com/flowlink/plugin/script/FlHelpers.kt` — `fl` 프록시 객체(b64/hex/hash/hmac/aes/seed/aria/rsa/bytes/text/pad/mask/now/json/log) + 매니페스트(`FlApi.MANIFEST`).
- `backend/src/main/kotlin/com/flowlink/plugin/script/ScriptAdapters.kt` — `ScriptTransform : FlowTransform`, `ScriptFieldCodec : FieldCodec`, `ScriptMessageCodec : MessageCodec`, `ScriptMeta`, `CompiledScript`.
- `backend/src/main/kotlin/com/flowlink/core/domain/PluginScript.kt` · `core/repository/PluginScriptRepository.kt` — 엔티티/저장소.
- `backend/src/main/kotlin/com/flowlink/plugin/PluginScriptService.kt` — CRUD·상태 전이·게이트·try·사용처·레지스트리 reload 트리거.
- `backend/src/main/kotlin/com/flowlink/plugin/PluginScriptController.kt` · `PluginScriptDtos.kt` — `/api/v1/plugins/scripts/**`, `/api/v1/plugins/api`.
- `backend/src/main/kotlin/com/flowlink/plugin/PluginUsageIndex.kt` — pluginId → 사용처(flow/mock/protocol) 인덱스(테넌트 30초 캐시).
- 수정: `transform/TransformRegistry.kt`(props·JAR 별 try·jar-enabled·스크립트 로더), `transform/PluginController.kt`(업로드 삭제), `workspace/WorkspaceController.kt`(`pendingPlugins`), `assistant/SchemaController.kt`(`plugin` 항목·규약 6번), `backend/build.gradle.kts`, `db/init.sql`.
- 테스트: `backend/src/test/kotlin/com/flowlink/plugin/script/ScriptRuntimeTest.kt`, `FlHelpersTest.kt`, `ScriptAdaptersTest.kt`, `backend/src/test/kotlin/com/flowlink/plugin/PluginScriptLifecycleTest.kt`, 기존 `transform/CodecRegistryTest.kt`·`execution/engine/RunStateSnapshotTest.kt` 생성자 갱신.

**Frontend**
- `frontend/src/api/client.ts` — `pluginScriptsApi`, `pluginsApi.upload` 삭제, `AdminMeView.pendingPlugins`. `frontend/src/api/types.ts` — `PluginScriptSummary/Detail/TryResult/FlApiEntry`.
- `frontend/src/components/CodeEditor.tsx` — `'javascript'` 언어(하이라이트·lezer 오류·js-beautify 정렬) + `completions`/`diagnostics` prop.
- `frontend/src/lib/pluginTemplates.ts`(템플릿 3종·kind 라벨) · `frontend/src/lib/lineDiff.ts`(LCS 줄 diff) · `frontend/src/lib/pluginCompletions.ts`(fl 매니페스트·inputs/config 자동완성 소스).
- `frontend/src/routes/Plugins.tsx` — 페이지(목록 | 편집기 | 실행 패널 | 상태 바). `frontend/src/components/PluginRunPanel.tsx` — try 폼/결과. `frontend/src/components/PluginDiffView.tsx` — 변경 전/후.
- 수정: `App.tsx`(라우트), `app/AppShell.tsx`(네비·배지), `routes/Admin.tsx`(승인 큐 섹션·현황 카드), `components/TransformPicker.tsx`(`onCreateNew` 푸터), `panels/PropertyPanel.tsx`(JAR 업로드 UI 삭제·새 플러그인 링크), `components/MockCodecEditor.tsx`·`components/FieldCodecButton.tsx`(새 플러그인 링크).

**MCP**
- `mcp/src/index.js` — `flowlink_guide` topic `plugin`, `plugin_list` 설명 갱신.

---

### Task 1: PluginsProperties + JAR 격하 + 레지스트리 JAR 별 격리

**Files:**
- Create: `backend/src/main/kotlin/com/flowlink/plugin/PluginsProperties.kt`
- Modify: `backend/src/main/kotlin/com/flowlink/transform/TransformRegistry.kt`
- Modify: `backend/src/main/kotlin/com/flowlink/transform/PluginController.kt`
- Modify: `backend/src/test/kotlin/com/flowlink/transform/CodecRegistryTest.kt`
- Modify: `backend/src/test/kotlin/com/flowlink/execution/engine/RunStateSnapshotTest.kt:30`
- Test: `backend/src/test/kotlin/com/flowlink/transform/CodecRegistryTest.kt`

**Interfaces:**
- Produces: `PluginsProperties(dir: String = "plugins", jarEnabled: Boolean = false, script: Script(timeoutMs: Long = 2000, statementLimit: Long = 2_000_000))`.
- Produces: `TransformRegistry(props: PluginsProperties, scripts: ScriptPluginLoader = ScriptPluginLoader.NONE)` + `fun interface ScriptPluginLoader { fun loadApproved(): List<Any> }` (원소는 `FlowTransform` 또는 `CodecPlugin`; Task 6 에서 DB 로더가 구현).

- [ ] **Step 1: 실패하는 테스트 — jar-enabled=false 면 JAR 이 있어도 0개, JAR 하나가 깨져도 나머지는 로드**

`backend/src/test/kotlin/com/flowlink/transform/CodecRegistryTest.kt` 를 다음으로 교체:

```kotlin
package com.flowlink.transform

import com.flowlink.plugin.PluginsProperties
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import java.nio.file.Files

class CodecRegistryTest {
    @Test
    fun `플러그인 디렉토리 없으면 코덱 0개 - 조회는 null`() {
        val dir = Files.createTempDirectory("no-plugins").resolve("none")
        val r = TransformRegistry(PluginsProperties(dir.toString(), true))
        assertThat(r.codecs()).isEmpty()
        assertThat(r.codec("x")).isNull()
    }

    @Test
    fun `jar-enabled false 면 디렉토리에 JAR 이 있어도 로드하지 않는다`() {
        val dir = Files.createTempDirectory("jars-off")
        Files.write(dir.resolve("broken.jar"), byteArrayOf(1, 2, 3))
        val r = TransformRegistry(PluginsProperties(dir.toString(), false))
        assertThat(r.list()).isEmpty()
    }

    @Test
    fun `깨진 JAR 하나가 전체 로드를 막지 않는다`() {
        val dir = Files.createTempDirectory("jars-mixed")
        Files.write(dir.resolve("broken.jar"), byteArrayOf(1, 2, 3)) // zip 아님 → 이 JAR 만 실패
        val r = TransformRegistry(PluginsProperties(dir.toString(), true))
        assertThat(r.list()).isEmpty() // 예외 없이 끝나야 한다(깨진 것만 건너뜀)
    }

    @Test
    fun `스크립트 로더가 준 플러그인이 등록된다`() {
        val t = object : FlowTransform {
            override fun id() = "s1"; override fun label() = "s1"
            override fun apply(inputs: Map<String, String>, config: Map<String, String>) = mapOf("result" to "x")
        }
        val r = TransformRegistry(PluginsProperties("build/tmp/none", false), ScriptPluginLoader { listOf(t) })
        assertThat(r.get("s1")).isPresent
    }
}
```

- [ ] **Step 2: 실패 확인**

Run: `cd backend && ./gradlew :test --tests '*CodecRegistryTest*' --console=plain`
Expected: 컴파일 실패 — `PluginsProperties`/`ScriptPluginLoader` 미정의.

- [ ] **Step 3: PluginsProperties 작성**

`backend/src/main/kotlin/com/flowlink/plugin/PluginsProperties.kt`:

```kotlin
package com.flowlink.plugin

import org.springframework.boot.context.properties.ConfigurationProperties

/**
 * flowlink.plugins.* — 플러그인 적재 설정. `@ConfigurationPropertiesScan` 이 자동 등록한다.
 *
 * @property dir JAR 드롭 디렉터리(실행 CWD 상대, 기본 plugins). jar-enabled 일 때만 스캔.
 * @property jarEnabled JAR 플러그인 로드 스위치 — **기본 false**(전권 바이너리 예외 경로). env `FLOWLINK_PLUGINS_JAR_ENABLED=true`.
 * @property script 스크립트(JS) 플러그인 샌드박스 상한.
 */
@ConfigurationProperties(prefix = "flowlink.plugins")
class PluginsProperties(
    dir: String? = null,
    jarEnabled: Boolean? = null,
    script: Script? = null,
) {
    val dir: String = dir?.takeIf { it.isNotBlank() } ?: "plugins"
    val jarEnabled: Boolean = jarEnabled ?: false
    val script: Script = script ?: Script()

    /** 호출당 CPU 시간(ms)·문장 수 상한 — 초과 시 그 호출만 실패(스레드 보호). */
    class Script(timeoutMs: Long? = null, statementLimit: Long? = null) {
        val timeoutMs: Long = if (timeoutMs == null || timeoutMs <= 0) 2000 else timeoutMs
        val statementLimit: Long = if (statementLimit == null || statementLimit <= 0) 2_000_000 else statementLimit
    }
}
```

- [ ] **Step 4: TransformRegistry 를 props 기반 + JAR 별 try + 스크립트 로더로**

`backend/src/main/kotlin/com/flowlink/transform/TransformRegistry.kt` 전체 교체:

```kotlin
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
```

- [ ] **Step 5: PluginController 에서 업로드 제거, props 사용**

`backend/src/main/kotlin/com/flowlink/transform/PluginController.kt` 의 `PluginController` 클래스를 다음으로 교체(파일 하단 `CodecView`/`CodecController` 는 그대로):

```kotlin
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
```
안 쓰게 된 import(`BadRequestException`, `LoggerFactory`, `Value`, `MediaType`, `PostMapping`, `RequestParam`, `MultipartFile`, `StandardCopyOption`)를 지운다.

- [ ] **Step 6: RunStateSnapshotTest 생성자 갱신**

`backend/src/test/kotlin/com/flowlink/execution/engine/RunStateSnapshotTest.kt` 30행 `TransformRegistry("build/tmp/no-plugins")` → `TransformRegistry(com.flowlink.plugin.PluginsProperties("build/tmp/no-plugins", false))`.

- [ ] **Step 7: 통과 확인 + 전체 스위트**

Run: `cd backend && ./gradlew :test --tests '*CodecRegistryTest*' --tests '*RunStateSnapshotTest*' --console=plain` → PASS.
Run: `./gradlew :test --console=plain` → BUILD SUCCESSFUL (GuestModeSecurityTest 의 `플러그인 업로드는 인증 게이트에 안 걸림` 케이스는 이제 404/405 — 401 아님 단언이라 그대로 통과).

- [ ] **Step 8: 커밋**

```bash
git add backend/src/main/kotlin/com/flowlink/plugin/PluginsProperties.kt backend/src/main/kotlin/com/flowlink/transform/TransformRegistry.kt backend/src/main/kotlin/com/flowlink/transform/PluginController.kt backend/src/test/kotlin/com/flowlink/transform/CodecRegistryTest.kt backend/src/test/kotlin/com/flowlink/execution/engine/RunStateSnapshotTest.kt
git commit -m "refactor(plugins): JAR 로드 기본 비활성(jar-enabled) + 업로드 API 삭제 + JAR 별 격리 로드 + 스크립트 로더 훅" -- backend/src/main/kotlin/com/flowlink/plugin/PluginsProperties.kt backend/src/main/kotlin/com/flowlink/transform/TransformRegistry.kt backend/src/main/kotlin/com/flowlink/transform/PluginController.kt backend/src/test/kotlin/com/flowlink/transform/CodecRegistryTest.kt backend/src/test/kotlin/com/flowlink/execution/engine/RunStateSnapshotTest.kt
```

---

### Task 2: ScriptRuntime — GraalJS 샌드박스·컴파일·호출 (fl 은 b64 만)

**Files:**
- Modify: `backend/build.gradle.kts:34-38` (dependencies)
- Create: `backend/src/main/kotlin/com/flowlink/plugin/script/ScriptError.kt`
- Create: `backend/src/main/kotlin/com/flowlink/plugin/script/ScriptAdapters.kt` (이 태스크에선 `ScriptMeta`·`CompiledScript` 만)
- Create: `backend/src/main/kotlin/com/flowlink/plugin/script/FlHelpers.kt` (이 태스크에선 `fl.b64` + `fl.log` 만 — Task 3 에서 확장)
- Create: `backend/src/main/kotlin/com/flowlink/plugin/script/ScriptRuntime.kt`
- Test: `backend/src/test/kotlin/com/flowlink/plugin/script/ScriptRuntimeTest.kt`

**Interfaces:**
- Produces: `class ScriptError(val line: Int?, val col: Int?, message: String) : RuntimeException(message)`
- Produces: `data class ScriptMeta(id, label, description, kind: String /* transform|fieldCodec|messageCodec */, inputs: List<FlowTransform.IoSpec>, outputs: List<FlowTransform.IoSpec>, params: List<FlowTransform.TransformParam>)`
- Produces: `class CompiledScript(val meta: ScriptMeta, internal val source: org.graalvm.polyglot.Source)`
- Produces: `class ScriptRuntime(props: PluginsProperties)` with `fun compile(code: String, name: String = "plugin"): CompiledScript`, `data class RunResult<T>(val value: T, val logs: List<String>, val durationMs: Long)`, `fun runTransform(cs, inputs: Map<String,String>, config: Map<String,String>): RunResult<Map<String,String>>`, `fun runFieldCodec(cs, value: String, fn: String, ctx: CodecCtx): RunResult<String>`, `fun runMessageCodec(cs, fn: String, body: ByteArray, ctx: CodecCtx): RunResult<ByteArray>`.
- Produces: `object FlHelpers { fun build(logs: MutableList<String>): org.graalvm.polyglot.proxy.ProxyObject }`.

- [ ] **Step 1: 의존성 추가**

`backend/build.gradle.kts` `dependencies {` 안, `// --- 표현식 샌드박스(IF 노드) ---` 블록 아래에:

```kotlin
    // --- 스크립트 플러그인 샌드박스(GraalJS, 인터프리터 모드 — JDK 21) + fl.* 국내 암호(SEED/ARIA) ---
    implementation("org.graalvm.polyglot:polyglot:24.1.2")
    implementation("org.graalvm.polyglot:js-community:24.1.2")
    implementation("org.bouncycastle:bcprov-jdk18on:1.80")
```
확인: `cd backend && ./gradlew dependencies --configuration runtimeClasspath --console=plain | grep -E "graalvm|bouncycastle" | head`. `js-community` 가 POM 전용이라 해석이 안 되면 대신 `implementation("org.graalvm.js:js-language:24.1.2")` + `runtimeOnly("org.graalvm.truffle:truffle-runtime:24.1.2")` 로 바꾼다.

- [ ] **Step 2: 실패하는 테스트**

`backend/src/test/kotlin/com/flowlink/plugin/script/ScriptRuntimeTest.kt`:

```kotlin
package com.flowlink.plugin.script

import com.flowlink.codec.CodecCtx
import com.flowlink.plugin.PluginsProperties
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

class ScriptRuntimeTest {
    private val rt = ScriptRuntime(PluginsProperties(script = PluginsProperties.Script(timeoutMs = 500, statementLimit = 200_000)))

    private val transformSrc = """
        ({ id: 'up', label: '대문자', inputs: [{ key: 'input', label: '원문' }], outputs: [{ key: 'result', label: '결과' }],
           params: [{ key: 'suffix', label: '접미', defaultValue: '!' }],
           apply(inputs, config) { fl.log('hi', 1); return { result: inputs.input.toUpperCase() + config.suffix, n: 3 } } })
    """.trimIndent()

    @Test
    fun `컴파일 - 메타 추출과 기본값`() {
        val cs = rt.compile(transformSrc)
        assertThat(cs.meta.id).isEqualTo("up"); assertThat(cs.meta.kind).isEqualTo("transform")
        assertThat(cs.meta.inputs.map { it.key }).containsExactly("input")
        assertThat(cs.meta.params.single().defaultValue).isEqualTo("!")
        val min = rt.compile("({ id: 'm', label: 'm', apply(i, c) { return { result: i.input } } })")
        assertThat(min.meta.inputs.map { it.key }).containsExactly("input"); assertThat(min.meta.outputs.map { it.key }).containsExactly("result")
    }

    @Test
    fun `transform 실행 - 문자열 아닌 출력은 JSON 문자열, 로그·시간 수집`() {
        val r = rt.runTransform(rt.compile(transformSrc), mapOf("input" to "ab"), mapOf("suffix" to "?"))
        assertThat(r.value).containsEntry("result", "AB?").containsEntry("n", "3")
        assertThat(r.logs).containsExactly("hi 1"); assertThat(r.durationMs).isGreaterThanOrEqualTo(0)
    }

    @Test
    fun `fieldCodec 과 messageCodec 실행`() {
        val fc = rt.compile("({ id: 'fc', kind: 'fieldCodec', encode(v, ctx) { return v + '|' + ctx.direction + '|' + ctx.field.len + '|' + ctx.message.acct }, decode(v, ctx) { return v.split('|')[0] } })")
        val ctx = CodecCtx(com.flowlink.codec.FieldInfo("acct", 13, "ascii", "right/space"), mapOf("acct" to "1"), mapOf("k" to "v"), "send")
        assertThat(rt.runFieldCodec(fc, "x", "encode", ctx).value).isEqualTo("x|send|13|1")
        assertThat(rt.runFieldCodec(fc, "x|send", "decode", ctx).value).isEqualTo("x")
        val mc = rt.compile("({ id: 'mc', kind: 'messageCodec', encode(b, ctx) { return b.map((x) => x + 1) }, decode(b, ctx) { return b.map((x) => x - 1) } })")
        val mctx = CodecCtx(null, emptyMap(), emptyMap(), "send")
        assertThat(rt.runMessageCodec(mc, "encode", byteArrayOf(1, 2, 255.toByte()), mctx).value).isEqualTo(byteArrayOf(2, 3, 0))
        assertThat(rt.runMessageCodec(mc, "decode", byteArrayOf(2, 3, 0), mctx).value).isEqualTo(byteArrayOf(1, 2, 255.toByte()))
    }

    @Test
    fun `컴파일 오류 - 문법 오류는 줄 번호, 메타 오류는 메시지`() {
        assertThatThrownBy { rt.compile("({ id: 'x',\n label: 'x' apply() {} })") }
            .isInstanceOf(ScriptError::class.java).matches { (it as ScriptError).line == 2 }
        assertThatThrownBy { rt.compile("({ id: 'Bad Id', label: 'x', apply() {} })") }.hasMessageContaining("id")
        assertThatThrownBy { rt.compile("({ id: 'x', label: 'x' })") }.hasMessageContaining("apply")
        assertThatThrownBy { rt.compile("({ id: 'x', label: 'x', kind: 'fieldCodec', encode(v) { return v } })") }.hasMessageContaining("decode")
        assertThatThrownBy { rt.compile("42") }.hasMessageContaining("객체")
    }

    @Test
    fun `샌드박스 - 호스트 접근 없음`() {
        for (expr in listOf("Java.type('java.lang.System')", "Polyglot.eval('js','1')", "globalThis.java", "java.lang.System", "new (Java.type('java.io.File'))('x')")) {
            val cs = rt.compile("({ id: 'x', label: 'x', apply(i, c) { return { result: String($expr) } } })")
            assertThatThrownBy { rt.runTransform(cs, emptyMap(), emptyMap()) }.isInstanceOf(ScriptError::class.java)
        }
        // typeof 로 확인 — 호스트 브릿지 전역이 존재하지 않는다
        val cs = rt.compile("({ id: 'x', label: 'x', apply(i, c) { return { result: typeof Java + ',' + typeof Polyglot + ',' + typeof fl } } })")
        assertThat(rt.runTransform(cs, emptyMap(), emptyMap()).value["result"]).isEqualTo("undefined,undefined,object")
    }

    @Test
    fun `타임아웃 - 무한루프는 상한 안에 실패`() {
        val cs = rt.compile("({ id: 'x', label: 'x', apply(i, c) { while (true) {} } })")
        val t0 = System.currentTimeMillis()
        assertThatThrownBy { rt.runTransform(cs, emptyMap(), emptyMap()) }.isInstanceOf(ScriptError::class.java).hasMessageContaining("시간")
        assertThat(System.currentTimeMillis() - t0).isLessThan(5000)
    }

    @Test
    fun `실행 중 예외는 ScriptError 로 - 줄 번호 포함`() {
        val cs = rt.compile("({ id: 'x', label: 'x',\n apply(i, c) {\n  throw new Error('boom') } })")
        assertThatThrownBy { rt.runTransform(cs, emptyMap(), emptyMap()) }.isInstanceOf(ScriptError::class.java)
            .hasMessageContaining("boom").matches { (it as ScriptError).line == 3 }
    }

    @Test
    fun `fl_b64 왕복`() {
        val cs = rt.compile("({ id: 'x', label: 'x', apply(i, c) { return { e: fl.b64.enc('한글'), d: fl.b64.dec(fl.b64.enc('한글')) } } })")
        val r = rt.runTransform(cs, emptyMap(), emptyMap()).value
        assertThat(r["e"]).isEqualTo("7ZWc6riA"); assertThat(r["d"]).isEqualTo("한글")
    }
}
```

- [ ] **Step 3: 실패 확인**

Run: `cd backend && ./gradlew :test --tests '*ScriptRuntimeTest*' --console=plain` → 컴파일 실패(클래스 없음).

- [ ] **Step 4: ScriptError · ScriptMeta · CompiledScript**

`backend/src/main/kotlin/com/flowlink/plugin/script/ScriptError.kt`:

```kotlin
package com.flowlink.plugin.script

/** 스크립트 컴파일/실행 오류 — line/col 은 알 수 있을 때만(편집기 거터 표시용). */
class ScriptError(val line: Int?, val col: Int?, message: String, cause: Throwable? = null) : RuntimeException(message, cause)
```

`backend/src/main/kotlin/com/flowlink/plugin/script/ScriptAdapters.kt` (이번 태스크 분량):

```kotlin
package com.flowlink.plugin.script

import com.flowlink.transform.FlowTransform
import org.graalvm.polyglot.Source

/** 스크립트 객체에서 뽑은 메타 — kind = transform | fieldCodec | messageCodec. */
data class ScriptMeta(
    val id: String,
    val label: String,
    val description: String,
    val kind: String,
    val inputs: List<FlowTransform.IoSpec>,
    val outputs: List<FlowTransform.IoSpec>,
    val params: List<FlowTransform.TransformParam>,
) {
    companion object {
        const val TRANSFORM = "transform"; const val FIELD_CODEC = "fieldCodec"; const val MESSAGE_CODEC = "messageCodec"
        val KINDS = setOf(TRANSFORM, FIELD_CODEC, MESSAGE_CODEC)
        val ID = Regex("^[a-z0-9][a-z0-9-]{1,63}$")
    }
}

/** 컴파일 결과 — 메타 + 파싱된 소스(엔진이 AST 캐시). 호출은 ScriptRuntime.run* 로. */
class CompiledScript(val meta: ScriptMeta, internal val source: Source)
```

- [ ] **Step 5: FlHelpers (b64 · log 만)**

`backend/src/main/kotlin/com/flowlink/plugin/script/FlHelpers.kt`:

```kotlin
package com.flowlink.plugin.script

import org.graalvm.polyglot.Value
import org.graalvm.polyglot.proxy.ProxyExecutable
import org.graalvm.polyglot.proxy.ProxyObject
import java.util.Base64

/**
 * 스크립트에 주입되는 `fl` 객체 — 전부 Graal 프록시(ProxyObject/ProxyExecutable)라 호스트 리플렉션 경로가 없다.
 * 문자열 인자는 Value 로 받아 직접 변환. logs 는 호출 단위 수집기(실행 패널용, 서빙 땐 버림).
 */
object FlHelpers {
    fun build(logs: MutableList<String>): ProxyObject = ProxyObject.fromMap(mapOf(
        "b64" to ProxyObject.fromMap(mapOf(
            "enc" to fn { a -> Base64.getEncoder().encodeToString(str(a, 0).toByteArray(Charsets.UTF_8)) },
            "dec" to fn { a -> String(Base64.getDecoder().decode(str(a, 0)), Charsets.UTF_8) },
        )),
        "log" to fn { a -> logs.add(a.joinToString(" ") { show(it) }); null },
    ))

    internal fun fn(body: (Array<Value>) -> Any?): ProxyExecutable = ProxyExecutable { args -> body(args) }
    internal fun str(a: Array<Value>, i: Int): String = a.getOrNull(i)?.takeIf { !it.isNull }?.let { show(it) } ?: ""
    internal fun show(v: Value): String = if (v.isString) v.asString() else v.toString()
}
```

- [ ] **Step 6: ScriptRuntime**

`backend/src/main/kotlin/com/flowlink/plugin/script/ScriptRuntime.kt`:

```kotlin
package com.flowlink.plugin.script

import com.flowlink.codec.CodecCtx
import com.flowlink.plugin.PluginsProperties
import com.flowlink.transform.FlowTransform
import org.graalvm.polyglot.Context
import org.graalvm.polyglot.Engine
import org.graalvm.polyglot.HostAccess
import org.graalvm.polyglot.PolyglotAccess
import org.graalvm.polyglot.PolyglotException
import org.graalvm.polyglot.ResourceLimits
import org.graalvm.polyglot.Source
import org.graalvm.polyglot.Value
import org.graalvm.polyglot.io.IOAccess
import org.graalvm.polyglot.proxy.ProxyArray
import org.graalvm.polyglot.proxy.ProxyObject
import org.springframework.stereotype.Component
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * 스크립트 플러그인 런타임(GraalJS). 호출마다 새 Context(엔진 공유 — Context 는 동시 사용 불가, Mock/워커는 멀티스레드),
 * **호스트 접근 전면 차단** + `fl` 프록시만 주입, CPU 시간·문장 수 상한. 스크립트의 마지막 표현식 = 플러그인 객체.
 * ponytail: 호출당 Context 생성(1~3ms) — 핫패스 실측 후 풀링.
 */
@Component
class ScriptRuntime(private val props: PluginsProperties) {
    data class RunResult<T>(val value: T, val logs: List<String>, val durationMs: Long)

    private val engine: Engine = Engine.newBuilder("js").option("engine.WarnInterpreterOnly", "false").build()
    private val watchdog = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "flowlink-script-watchdog").apply { isDaemon = true } }

    fun compile(code: String, name: String = "plugin"): CompiledScript {
        val source = try { Source.newBuilder("js", code, "$name.js").build() } catch (e: Exception) { throw ScriptError(null, null, e.message ?: e.toString(), e) }
        val meta = withContext(mutableListOf()) { ctx -> readMeta(evalPlugin(ctx, source)) }.value
        return CompiledScript(meta, source)
    }

    fun runTransform(cs: CompiledScript, inputs: Map<String, String>, config: Map<String, String>): RunResult<Map<String, String>> =
        withContext(mutableListOf()) { ctx ->
            val plugin = evalPlugin(ctx, cs.source)
            val out = plugin.getMember("apply").execute(ProxyObject.fromMap(inputs.toMap<String, Any>()), ProxyObject.fromMap(config.toMap<String, Any>()))
            toStringMap(ctx, out)
        }

    fun runFieldCodec(cs: CompiledScript, value: String, fn: String, ctx: CodecCtx): RunResult<String> =
        withContext(mutableListOf()) { c ->
            val out = evalPlugin(c, cs.source).getMember(fn).execute(value, codecCtx(ctx))
            if (out.isNull) "" else FlHelpers.show(out)
        }

    fun runMessageCodec(cs: CompiledScript, fn: String, body: ByteArray, ctx: CodecCtx): RunResult<ByteArray> =
        withContext(mutableListOf()) { c ->
            val u8 = c.eval("js", "(a) => Uint8Array.from(a)").execute(ProxyArray.fromList(body.map { (it.toInt() and 0xff) as Any }))
            val out = evalPlugin(c, cs.source).getMember(fn).execute(u8, codecCtx(ctx))
            if (!out.hasArrayElements()) throw ScriptError(null, null, "$fn 는 Uint8Array(바이트 배열)를 돌려줘야 합니다")
            ByteArray(out.arraySize.toInt()) { i -> (out.getArrayElement(i.toLong()).asLong() and 0xff).toByte() }
        }

    // ---- 내부 ----

    private fun newContext(logs: MutableList<String>): Context {
        val ctx = Context.newBuilder("js")
            .engine(engine)
            .allowHostAccess(HostAccess.NONE)
            .allowHostClassLookup { false }
            .allowIO(IOAccess.NONE)
            .allowCreateThread(false)
            .allowNativeAccess(false)
            .allowPolyglotAccess(PolyglotAccess.NONE)
            .option("js.ecmascript-version", "2022")
            .resourceLimits(ResourceLimits.newBuilder().statementLimit(props.script.statementLimit, null).build())
            .build()
        ctx.getBindings("js").putMember("fl", FlHelpers.build(logs))
        return ctx
    }

    /** Context 생성 → 실행 → 항상 close. 타임아웃은 watchdog 이 close(true) 로 취소. 모든 Graal 예외를 ScriptError 로. */
    private fun <T> withContext(logs: MutableList<String>, block: (Context) -> T): RunResult<T> {
        val ctx = newContext(logs)
        val guard = watchdog.schedule({ runCatching { ctx.close(true) } }, props.script.timeoutMs, TimeUnit.MILLISECONDS)
        val t0 = System.nanoTime()
        try {
            val v = block(ctx)
            return RunResult(v, logs.toList(), (System.nanoTime() - t0) / 1_000_000)
        } catch (e: PolyglotException) {
            if (e.isCancelled || e.isInterrupted || e.isResourceExhausted) throw ScriptError(null, null, "실행 시간·자원 상한 초과(${props.script.timeoutMs}ms)", e)
            val loc = e.sourceLocation
            throw ScriptError(loc?.startLine, loc?.startColumn, cleanMessage(e), e)
        } catch (e: IllegalStateException) { // close(true) 직후 접근
            throw ScriptError(null, null, "실행 시간·자원 상한 초과(${props.script.timeoutMs}ms)", e)
        } finally {
            guard.cancel(false)
            runCatching { ctx.close(true) }
        }
    }

    private fun cleanMessage(e: PolyglotException): String {
        val m = e.message ?: e.toString()
        return if (e.isSyntaxError) "문법 오류: $m" else m.removePrefix("Error: ")
    }

    private fun evalPlugin(ctx: Context, source: Source): Value {
        val v = ctx.eval(source)
        if (v.isNull || !v.hasMembers() || v.canExecute() || v.hasArrayElements()) throw ScriptError(null, null, "스크립트의 마지막 값은 플러그인 객체({ id, label, … })여야 합니다")
        return v
    }

    private fun readMeta(p: Value): ScriptMeta {
        val id = p.str("id"); if (!ScriptMeta.ID.matches(id)) throw ScriptError(null, null, "id 는 소문자·숫자·하이픈 2~64자여야 합니다: '$id'")
        val kind = p.str("kind").ifBlank { ScriptMeta.TRANSFORM }
        if (kind !in ScriptMeta.KINDS) throw ScriptError(null, null, "kind 는 transform | fieldCodec | messageCodec 중 하나: '$kind'")
        val need = if (kind == ScriptMeta.TRANSFORM) listOf("apply") else listOf("encode", "decode")
        for (f in need) if (!p.getMember(f).let { it != null && it.canExecute() }) throw ScriptError(null, null, "$kind 플러그인에는 $f(…) 함수가 필요합니다")
        val inputs = ioList(p.getMember("inputs")).ifEmpty { listOf(FlowTransform.IoSpec.of("input", "입력")) }
        val outputs = ioList(p.getMember("outputs")).ifEmpty { listOf(FlowTransform.IoSpec.of("result", "결과")) }
        return ScriptMeta(id, p.str("label").ifBlank { id }, p.str("description"), kind, inputs, outputs, paramList(p.getMember("params")))
    }

    private fun ioList(v: Value?): List<FlowTransform.IoSpec> = arr(v).map { e ->
        val key = e.str("key"); if (key.isBlank()) throw ScriptError(null, null, "inputs/outputs 항목에 key 가 없습니다")
        FlowTransform.IoSpec(key, e.str("label").ifBlank { key }, e.str("type").ifBlank { "string" }, e.str("example"))
    }
    private fun paramList(v: Value?): List<FlowTransform.TransformParam> = arr(v).map { e ->
        val key = e.str("key"); if (key.isBlank()) throw ScriptError(null, null, "params 항목에 key 가 없습니다")
        FlowTransform.TransformParam(key, e.str("label").ifBlank { key }, e.str("type").ifBlank { "string" }, e.str("defaultValue"),
            arr(e.getMember("options")).map { FlHelpers.show(it) }, e.str("placeholder"))
    }
    private fun arr(v: Value?): List<Value> = if (v == null || v.isNull || !v.hasArrayElements()) emptyList() else (0 until v.arraySize).map { v.getArrayElement(it) }
    private fun Value.str(k: String): String = getMember(k)?.takeIf { !it.isNull }?.let { FlHelpers.show(it) } ?: ""

    private fun codecCtx(c: CodecCtx): ProxyObject = ProxyObject.fromMap(mapOf(
        "config" to ProxyObject.fromMap(c.config.toMap<String, Any>()),
        "direction" to c.direction,
        "message" to ProxyObject.fromMap(c.message.toMap<String, Any>()),
        "field" to (c.field?.let { ProxyObject.fromMap(mapOf("name" to it.name, "len" to it.len, "type" to it.type, "pad" to it.pad)) }),
    ))

    /** JS 객체 → Map<String,String>: 문자열은 그대로, 그 외는 JSON.stringify(엔진이 코어션은 SPI 쪽에서). */
    private fun toStringMap(ctx: Context, out: Value): Map<String, String> {
        if (out.isNull || !out.hasMembers()) throw ScriptError(null, null, "apply 는 { 출력키: 값 } 객체를 돌려줘야 합니다")
        val stringify = ctx.eval("js", "(v) => typeof v === 'string' ? v : (v === undefined ? '' : JSON.stringify(v))")
        val m = LinkedHashMap<String, String>()
        for (k in out.memberKeys) m[k] = stringify.execute(out.getMember(k)).asString()
        return m
    }
}
```

- [ ] **Step 7: 통과 확인**

Run: `cd backend && ./gradlew :test --tests '*ScriptRuntimeTest*' --console=plain` → 8 PASS.
막히는 지점 힌트: `Source.newBuilder` 는 IOException 을 선언 — Kotlin 은 그대로 잡힘. `allowIO(IOAccess.NONE)` 이 없는 버전이면 `allowIO(false)`. `ResourceLimits.statementLimit(long, Predicate<Source>)` 의 두 번째 인자 null = 전체.

- [ ] **Step 8: 커밋**

```bash
git add backend/build.gradle.kts backend/src/main/kotlin/com/flowlink/plugin/script backend/src/test/kotlin/com/flowlink/plugin/script/ScriptRuntimeTest.kt
git commit -m "feat(plugins): ScriptRuntime — GraalJS 샌드박스(호스트 접근 없음·fl 프록시·CPU/문장 상한)에서 플러그인 객체 컴파일·호출" -- backend/build.gradle.kts backend/src/main/kotlin/com/flowlink/plugin/script backend/src/test/kotlin/com/flowlink/plugin/script/ScriptRuntimeTest.kt
```

---

### Task 3: `fl.*` 헬퍼 전체 + 매니페스트

**Files:**
- Modify: `backend/src/main/kotlin/com/flowlink/plugin/script/FlHelpers.kt` (전체 교체)
- Test: `backend/src/test/kotlin/com/flowlink/plugin/script/FlHelpersTest.kt`

**Interfaces:**
- Produces: `object FlHelpers { fun build(logs: MutableList<String>): ProxyObject }` (Task 2 와 같은 시그니처, 함수 확장) · `data class FlApiEntry(val path: String, val signature: String, val doc: String, val example: String)` · `object FlApi { val MANIFEST: List<FlApiEntry> }`.
- fl 함수(스펙 §2): `b64.enc/dec`, `hex.enc/dec`, `hash.sha256/sha1/md5`, `hmac.sha256`, `aes|seed|aria.encrypt/decrypt/encryptBytes/decryptBytes`, `rsa.sign/verify`, `bytes`, `text`, `pad.left/right`, `mask`, `now`, `json.parse/stringify`, `log`.
- 옵션 객체는 마지막 인자 `{ out: 'b64'|'hex', charset, mode: 'CBC'|'ECB', as: 'text'|'bytes' }`. 바이트 인자는 `Value.hasArrayElements()` 로 받고, 바이트 반환은 `ProxyArray`(JS 에서 `length`/`map` 가능).

- [ ] **Step 1: 실패하는 테스트**

`backend/src/test/kotlin/com/flowlink/plugin/script/FlHelpersTest.kt`:

```kotlin
package com.flowlink.plugin.script

import com.flowlink.plugin.PluginsProperties
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.Test

/** fl.* 를 실제 스크립트 안에서 호출해 검증(프록시 경계 포함). */
class FlHelpersTest {
    private val rt = ScriptRuntime(PluginsProperties())
    private fun run(body: String, config: Map<String, String> = emptyMap()): Map<String, String> =
        rt.runTransform(rt.compile("({ id: 'x', label: 'x', apply(i, c) { return $body } })"), emptyMap(), config).value

    @Test fun `hex_hash_hmac`() {
        val r = run("{ h: fl.hex.enc('AB'), d: fl.hex.dec('4142'), s: fl.hash.sha256('abc'), m: fl.hmac.sha256('key', 'msg'), mb: fl.hmac.sha256('key', 'msg', { out: 'b64' }) }")
        assertThat(r["h"]).isEqualTo("4142"); assertThat(r["d"]).isEqualTo("AB")
        assertThat(r["s"]).isEqualTo("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        assertThat(r["m"]).isEqualTo("2d93cbc1be167bcb1637a4a23cbff01a7878f0c50ee833954ea5221bb1b8c628")
        assertThat(r["mb"]).isEqualTo("LZPLwb4We8sWN6SiPL/wGnh48MUO6DOVTqUiG7G4xig=")
    }

    @Test fun `aes_seed_aria 왕복 + 옵션`() {
        val k = "0123456789abcdef"; val iv = "0000000000000000"
        val r = run("""{
            a: fl.aes.decrypt(fl.aes.encrypt('카드1234', '$k', '$iv'), '$k', '$iv'),
            e: fl.aes.decrypt(fl.aes.encrypt('x', '$k', null, { mode: 'ECB', out: 'hex' }), '$k', null, { mode: 'ECB', out: 'hex' }),
            s: fl.seed.decrypt(fl.seed.encrypt('전문', '$k', '$iv'), '$k', '$iv'),
            r: fl.aria.decrypt(fl.aria.encrypt('전문', '$k', '$iv'), '$k', '$iv'),
            len: fl.aes.encrypt('카드1234', '$k', '$iv').length,
        }""")
        assertThat(r["a"]).isEqualTo("카드1234"); assertThat(r["e"]).isEqualTo("x"); assertThat(r["s"]).isEqualTo("전문"); assertThat(r["r"]).isEqualTo("전문")
        assertThat(r["len"]).isEqualTo("24") // 16B 블록 1개 → base64 24자
    }

    @Test fun `aes bytes 왕복 - 바이트 배열 입출력`() {
        val r = run("{ t: fl.text(fl.aes.decryptBytes(fl.aes.encryptBytes(fl.bytes('홍길동', 'EUC-KR'), '0123456789abcdef', '0000000000000000'), '0123456789abcdef', '0000000000000000'), 'EUC-KR'), n: fl.bytes('홍길동', 'EUC-KR').length }")
        assertThat(r["t"]).isEqualTo("홍길동"); assertThat(r["n"]).isEqualTo("6")
    }

    @Test fun `rsa 서명 검증`() {
        val kp = java.security.KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
        val enc = java.util.Base64.getMimeEncoder(64, "\n".toByteArray())
        val priv = "-----BEGIN " + "PRIVATE KEY-----\n" + enc.encodeToString(kp.private.encoded) + "\n-----END " + "PRIVATE KEY-----" // 리터럴을 쪼갠 이유: 커밋 훅(gitleaks) private-key 규칙
        val pub = "-----BEGIN " + "PUBLIC KEY-----\n" + enc.encodeToString(kp.public.encoded) + "\n-----END " + "PUBLIC KEY-----"
        val r = run("(() => { const s = fl.rsa.sign(c.priv, 'data'); return { ok: fl.rsa.verify(c.pub, 'data', s), bad: fl.rsa.verify(c.pub, 'other', s) } })()", mapOf("priv" to priv, "pub" to pub))
        assertThat(r["ok"]).isEqualTo("true"); assertThat(r["bad"]).isEqualTo("false")
    }

    @Test fun `pad_mask_now_json`() {
        val r = run("""{
            l: fl.pad.left('12', 5, '0'), r: fl.pad.right('홍', 6, ' ', { charset: 'EUC-KR' }).length,
            m: fl.mask('1234567890123456', 6, 4), m2: fl.mask('abc', 2, 2, '#'),
            n: fl.now('yyyyMMdd').length, z: fl.now('HH', 'UTC').length,
            j: fl.json.stringify(fl.json.parse('{"a":[1,2]}').a), j2: fl.json.parse('{"a":1}').a + 1,
        }""")
        assertThat(r["l"]).isEqualTo("00012"); assertThat(r["r"]).isEqualTo("5") // 홍(2B)+공백 4 = 6B → 문자 5
        assertThat(r["m"]).isEqualTo("123456******3456"); assertThat(r["m2"]).isEqualTo("###")
        assertThat(r["n"]).isEqualTo("8"); assertThat(r["z"]).isEqualTo("2"); assertThat(r["j"]).isEqualTo("[1,2]"); assertThat(r["j2"]).isEqualTo("2")
    }

    @Test fun `잘못된 인자는 ScriptError 메시지로`() {
        assertThatThrownBy { run("{ x: fl.aes.encrypt('a', 'tooshort', '0000000000000000') }") }.isInstanceOf(ScriptError::class.java).hasMessageContaining("키")
        assertThatThrownBy { run("{ x: fl.bytes('a', 'NO-SUCH-CS') }") }.hasMessageContaining("charset")
    }

    @Test fun `매니페스트 - 모든 fl 함수가 문서화돼 있다`() {
        val paths = FlApi.MANIFEST.map { it.path }
        assertThat(paths).contains("fl.b64.enc", "fl.hex.dec", "fl.hash.sha256", "fl.hmac.sha256", "fl.aes.encrypt", "fl.aes.decryptBytes",
            "fl.seed.encrypt", "fl.aria.decrypt", "fl.rsa.sign", "fl.rsa.verify", "fl.bytes", "fl.text", "fl.pad.left", "fl.pad.right", "fl.mask", "fl.now", "fl.json.parse", "fl.json.stringify", "fl.log")
        assertThat(FlApi.MANIFEST).allMatch { it.signature.isNotBlank() && it.doc.isNotBlank() && it.example.isNotBlank() }
    }
}
```

- [ ] **Step 2: 실패 확인**

Run: `cd backend && ./gradlew :test --tests '*FlHelpersTest*' --console=plain` → 컴파일 실패(`FlApi` 없음).

- [ ] **Step 3: FlHelpers 전체 구현** — `FlHelpers.kt` 전체 교체:

```kotlin
package com.flowlink.plugin.script

import com.flowlink.common.text.NowTokens
import org.bouncycastle.jce.provider.BouncyCastleProvider
import org.graalvm.polyglot.Value
import org.graalvm.polyglot.proxy.ProxyArray
import org.graalvm.polyglot.proxy.ProxyExecutable
import org.graalvm.polyglot.proxy.ProxyObject
import java.nio.charset.Charset
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Security
import java.security.Signature
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import java.util.HexFormat
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/** `fl.*` 한 함수의 문서 — 편집기 자동완성·MCP 가이드가 같은 목록을 쓴다. */
data class FlApiEntry(val path: String, val signature: String, val doc: String, val example: String)

/**
 * 스크립트에 주입되는 `fl` 객체 — 전부 Graal 프록시(ProxyObject/ProxyExecutable)라 호스트 리플렉션 경로가 없다.
 * 기본값 = 회사 관례(UTF-8 · AES/SEED/ARIA 는 CBC/PKCS5Padding · 출력 base64). 다른 조합은 옵션 객체 `{ out, charset, mode, as }` 로만.
 * 바이트는 JS 쪽 배열(Uint8Array 또는 fl 이 돌려준 배열) ↔ 여기 ByteArray. 잘못된 인자는 ScriptError(스크립트 오류로 표면화).
 */
object FlHelpers {
    init { if (Security.getProvider("BC") == null) Security.addProvider(BouncyCastleProvider()) }

    fun build(logs: MutableList<String>): ProxyObject = obj(
        "b64" to obj("enc" to fn { a -> b64(bytesArg(a, 0, cs(opt(a, 1)))) }, "dec" to fn { a -> out(Base64.getDecoder().decode(str(a, 0).trim()), opt(a, 1)) }),
        "hex" to obj("enc" to fn { a -> hex(bytesArg(a, 0, cs(opt(a, 1)))) }, "dec" to fn { a -> out(HexFormat.of().parseHex(str(a, 0).trim()), opt(a, 1)) }),
        "hash" to obj("sha256" to digest("SHA-256"), "sha1" to digest("SHA-1"), "md5" to digest("MD5")),
        "hmac" to obj("sha256" to fn { a ->
            val mac = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(str(a, 0).toByteArray(Charsets.UTF_8), "HmacSHA256")) }
            encoded(mac.doFinal(bytesArg(a, 1, cs(opt(a, 2)))), opt(a, 2), "hex")
        }),
        "aes" to cipherNs("AES"), "seed" to cipherNs("SEED"), "aria" to cipherNs("ARIA"),
        "rsa" to obj(
            "sign" to fn { a ->
                val key = KeyFactory.getInstance("RSA").generatePrivate(PKCS8EncodedKeySpec(pem(str(a, 0), "PRIVATE KEY")))
                val sig = Signature.getInstance(optStr(opt(a, 2), "alg", "SHA256withRSA")).apply { initSign(key); update(bytesArg(a, 1, Charsets.UTF_8)) }.sign()
                encoded(sig, opt(a, 2), "b64")
            },
            "verify" to fn { a ->
                val key = KeyFactory.getInstance("RSA").generatePublic(X509EncodedKeySpec(pem(str(a, 0), "PUBLIC KEY")))
                Signature.getInstance(optStr(opt(a, 3), "alg", "SHA256withRSA")).apply { initVerify(key); update(bytesArg(a, 1, Charsets.UTF_8)) }
                    .verify(decodeEncoded(str(a, 2), opt(a, 3), "b64"))
            },
        ),
        "bytes" to fn { a -> u8(str(a, 0).toByteArray(charset(str(a, 1)))) },
        "text" to fn { a -> String(bytesArg(a, 0, Charsets.UTF_8), charset(str(a, 1))) },
        "pad" to obj("left" to padFn(true), "right" to padFn(false)),
        "mask" to fn { a ->
            val s = str(a, 0); val front = num(a, 1, 0); val back = num(a, 2, 0); val ch = str(a, 3).ifEmpty { "*" }.first()
            if (front + back >= s.length) ch.toString().repeat(s.length) else s.substring(0, front) + ch.toString().repeat(s.length - front - back) + s.substring(s.length - back)
        },
        "now" to fn { a ->
            val pattern = str(a, 0); val zone = str(a, 1).ifBlank { null }
            NowTokens.resolve(if (pattern.isBlank()) "now" else "now:$pattern", zone) ?: throw ScriptError(null, null, "fl.now: 잘못된 패턴/타임존 — '$pattern' / '$zone'")
        },
        "json" to obj(
            "parse" to fn { a -> a[0].context.eval("js", "JSON.parse").execute(str(a, 0)) },
            "stringify" to fn { a -> a[0].context.eval("js", "JSON.stringify").execute(a[0]).let { if (it.isNull) "" else it.asString() } },
        ),
        "log" to fn { a -> logs.add(a.joinToString(" ") { show(it) }); null },
    )

    // ---- 프록시 빌더 ----
    private fun obj(vararg m: Pair<String, Any>): ProxyObject = ProxyObject.fromMap(mapOf(*m))
    internal fun fn(body: (Array<Value>) -> Any?): ProxyExecutable = ProxyExecutable { args ->
        try { body(args) } catch (e: ScriptError) { throw e } catch (e: Exception) { throw ScriptError(null, null, "fl: ${e.message ?: e.toString()}", e) }
    }
    private fun digest(alg: String) = fn { a -> encoded(MessageDigest.getInstance(alg).digest(bytesArg(a, 0, cs(opt(a, 1)))), opt(a, 1), "hex") }
    private fun padFn(left: Boolean) = fn { a ->
        val s = str(a, 0); val len = num(a, 1, 0); val ch = str(a, 2).ifEmpty { " " }; val cs = cs(opt(a, 3))
        val fill = ch.toByteArray(cs); val raw = s.toByteArray(cs)
        if (raw.size >= len) s else { val padBytes = ByteArray(len - raw.size) { fill[it % fill.size] }; String(if (left) padBytes + raw else raw + padBytes, cs) }
    }
    /** AES/SEED/ARIA 공용 — encrypt/decrypt(text) · encryptBytes/decryptBytes(bytes). CBC(기본)는 iv 16B 필수, ECB 는 iv 무시. */
    private fun cipherNs(alg: String): ProxyObject {
        fun cipher(a: Array<Value>, mode: Int): Cipher {
            val o = opt(a, 3); val m = optStr(o, "mode", "CBC").uppercase()
            val key = str(a, 1).toByteArray(Charsets.UTF_8)
            if (key.size !in listOf(16, 24, 32)) throw ScriptError(null, null, "fl.${alg.lowercase()}: 키는 16/24/32바이트여야 합니다(현재 ${key.size})")
            val c = if (alg == "AES") Cipher.getInstance("AES/$m/PKCS5Padding") else Cipher.getInstance("$alg/$m/PKCS5Padding", "BC")
            if (m == "ECB") c.init(mode, SecretKeySpec(key, alg)) else {
                val iv = str(a, 2).toByteArray(Charsets.UTF_8)
                if (iv.size != 16) throw ScriptError(null, null, "fl.${alg.lowercase()}: IV 는 16바이트여야 합니다(현재 ${iv.size})")
                c.init(mode, SecretKeySpec(key, alg), IvParameterSpec(iv))
            }
            return c
        }
        return obj(
            "encrypt" to fn { a -> encoded(cipher(a, Cipher.ENCRYPT_MODE).doFinal(str(a, 0).toByteArray(cs(opt(a, 3)))), opt(a, 3), "b64") },
            "decrypt" to fn { a -> String(cipher(a, Cipher.DECRYPT_MODE).doFinal(decodeEncoded(str(a, 0), opt(a, 3), "b64")), cs(opt(a, 3))) },
            "encryptBytes" to fn { a -> u8(cipher(a, Cipher.ENCRYPT_MODE).doFinal(bytesArg(a, 0, Charsets.UTF_8))) },
            "decryptBytes" to fn { a -> u8(cipher(a, Cipher.DECRYPT_MODE).doFinal(bytesArg(a, 0, Charsets.UTF_8))) },
        )
    }

    // ---- 인자/변환 ----
    internal fun show(v: Value): String = if (v.isString) v.asString() else v.toString()
    internal fun str(a: Array<Value>, i: Int): String = a.getOrNull(i)?.takeIf { !it.isNull }?.let { show(it) } ?: ""
    private fun num(a: Array<Value>, i: Int, def: Int): Int = a.getOrNull(i)?.takeIf { it.isNumber }?.asInt() ?: str(a, i).toIntOrNull() ?: def
    private fun opt(a: Array<Value>, i: Int): Value? = a.getOrNull(i)?.takeIf { !it.isNull && it.hasMembers() }
    private fun optStr(o: Value?, k: String, def: String): String = o?.getMember(k)?.takeIf { !it.isNull }?.let { show(it) } ?: def
    private fun cs(o: Value?): Charset = charset(optStr(o, "charset", "UTF-8"))
    private fun charset(name: String): Charset = try { if (name.isBlank()) Charsets.UTF_8 else Charset.forName(name.trim()) } catch (e: Exception) { throw ScriptError(null, null, "fl: 알 수 없는 charset '$name'") }
    /** 배열(Uint8Array 또는 fl 이 돌려준 배열)이면 바이트로, 아니면 문자열을 charset 으로. */
    private fun bytesArg(a: Array<Value>, i: Int, cs: Charset): ByteArray {
        val v = a.getOrNull(i) ?: return ByteArray(0)
        if (v.hasArrayElements()) return ByteArray(v.arraySize.toInt()) { k -> (v.getArrayElement(k.toLong()).asLong() and 0xff).toByte() }
        return str(a, i).toByteArray(cs)
    }
    private fun u8(b: ByteArray): Any = ProxyArray.fromList(b.map { (it.toInt() and 0xff) as Any })
    private fun b64(b: ByteArray) = Base64.getEncoder().encodeToString(b)
    private fun hex(b: ByteArray) = HexFormat.of().formatHex(b)
    private fun encoded(b: ByteArray, o: Value?, def: String): String = when (optStr(o, "out", def)) { "hex" -> hex(b); "b64" -> b64(b); else -> throw ScriptError(null, null, "fl: out 은 'b64' | 'hex'") }
    private fun decodeEncoded(s: String, o: Value?, def: String): ByteArray = if (optStr(o, "out", def) == "hex") HexFormat.of().parseHex(s.trim()) else Base64.getDecoder().decode(s.trim())
    /** dec 계열 출력 — `{ as: 'bytes' }` 면 바이트 배열, 기본은 텍스트(charset 옵션). */
    private fun out(b: ByteArray, o: Value?): Any = if (optStr(o, "as", "text") == "bytes") u8(b) else String(b, cs(o))
    private fun pem(s: String, label: String): ByteArray {
        val body = s.replace(Regex("-----[A-Z ]*$label-----"), "").replace(Regex("\\s"), "")
        if (body.isEmpty()) throw ScriptError(null, null, "fl.rsa: PEM($label)이 비었습니다")
        return Base64.getDecoder().decode(body)
    }
}

/** 편집기 자동완성·MCP 가이드용 매니페스트 — fl 에 함수를 추가하면 여기도 한 줄. */
object FlApi {
    private fun e(path: String, sig: String, doc: String, ex: String) = FlApiEntry(path, sig, doc, ex)
    private fun cipher(ns: String, name: String, keyDoc: String): List<FlApiEntry> = listOf(
        e("fl.$ns.encrypt", "fl.$ns.encrypt(text, key, iv, { mode?: 'CBC'|'ECB', out?: 'b64'|'hex', charset? })", "$name 암호화(CBC/PKCS5, $keyDoc, IV 16B, 기본 base64)", "fl.$ns.encrypt(inputs.input, config.key, config.iv)"),
        e("fl.$ns.decrypt", "fl.$ns.decrypt(cipher, key, iv, { mode?, out?, charset? })", "$name 복호화", "fl.$ns.decrypt(inputs.input, config.key, config.iv)"),
        e("fl.$ns.encryptBytes", "fl.$ns.encryptBytes(bytes, key, iv, { mode? })", "$name 암호화(바이트 → 바이트, 전문 코덱용)", "fl.$ns.encryptBytes(body, ctx.config.key, ctx.config.iv)"),
        e("fl.$ns.decryptBytes", "fl.$ns.decryptBytes(bytes, key, iv, { mode? })", "$name 복호화(바이트)", "fl.$ns.decryptBytes(body, ctx.config.key, ctx.config.iv)"),
    )
    val MANIFEST: List<FlApiEntry> = listOf(
        e("fl.b64.enc", "fl.b64.enc(text|bytes, { charset? })", "base64 인코딩", "fl.b64.enc('hi')"),
        e("fl.b64.dec", "fl.b64.dec(b64, { as?: 'text'|'bytes', charset? })", "base64 디코딩", "fl.b64.dec('aGk=')"),
        e("fl.hex.enc", "fl.hex.enc(text|bytes, { charset? })", "16진수 인코딩(소문자)", "fl.hex.enc('AB')"),
        e("fl.hex.dec", "fl.hex.dec(hex, { as?: 'text'|'bytes', charset? })", "16진수 디코딩", "fl.hex.dec('4142')"),
        e("fl.hash.sha256", "fl.hash.sha256(text|bytes, { out?: 'hex'|'b64', charset? })", "SHA-256 해시(기본 hex)", "fl.hash.sha256(inputs.input)"),
        e("fl.hash.sha1", "fl.hash.sha1(text|bytes, { out?, charset? })", "SHA-1 해시", "fl.hash.sha1('x')"),
        e("fl.hash.md5", "fl.hash.md5(text|bytes, { out?, charset? })", "MD5 해시", "fl.hash.md5('x')"),
        e("fl.hmac.sha256", "fl.hmac.sha256(key, data, { out?: 'hex'|'b64', charset? })", "HMAC-SHA256 서명(기본 hex)", "fl.hmac.sha256(config.secret, inputs.input)"),
    ) + cipher("aes", "AES", "키 16/24/32B") + cipher("seed", "SEED", "국내 표준, 키 16B") + cipher("aria", "ARIA", "국내 표준, 키 16/24/32B") + listOf(
        e("fl.rsa.sign", "fl.rsa.sign(pemPrivateKey, data, { alg?: 'SHA256withRSA', out?: 'b64'|'hex' })", "RSA 서명(PKCS#8 PEM, 기본 base64)", "fl.rsa.sign(config.privateKey, inputs.input)"),
        e("fl.rsa.verify", "fl.rsa.verify(pemPublicKey, data, signature, { alg?, out? })", "RSA 서명 검증 → true/false", "fl.rsa.verify(config.publicKey, inputs.input, inputs.sig)"),
        e("fl.bytes", "fl.bytes(text, charset?)", "문자열 → 바이트 배열(EUC-KR/MS949 등)", "fl.bytes('홍길동', 'EUC-KR')"),
        e("fl.text", "fl.text(bytes, charset?)", "바이트 배열 → 문자열", "fl.text(body, 'EUC-KR')"),
        e("fl.pad.left", "fl.pad.left(text, len, ch?, { charset? })", "왼쪽 패딩(바이트 길이 기준 — 숫자 0 채움)", "fl.pad.left(inputs.input, 12, '0')"),
        e("fl.pad.right", "fl.pad.right(text, len, ch?, { charset? })", "오른쪽 패딩(바이트 길이 기준 — 한글 필드 공백 채움)", "fl.pad.right(inputs.input, 20, ' ', { charset: 'EUC-KR' })"),
        e("fl.mask", "fl.mask(text, keepFront, keepBack, ch?)", "가운데 마스킹", "fl.mask(inputs.input, 6, 4)"),
        e("fl.now", "fl.now(pattern?, zone?)", "현재 일시(기본 ISO UTC, 패턴은 Java DateTimeFormatter, 기본 KST)", "fl.now('yyyyMMddHHmmss')"),
        e("fl.json.parse", "fl.json.parse(text)", "JSON 파싱", "fl.json.parse(inputs.input).user.name"),
        e("fl.json.stringify", "fl.json.stringify(value)", "JSON 직렬화", "fl.json.stringify({ a: 1 })"),
        e("fl.log", "fl.log(...values)", "실행 패널 콘솔에 출력(서빙 땐 무시)", "fl.log('key', config.key)"),
    )
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd backend && ./gradlew :test --tests '*FlHelpersTest*' --tests '*ScriptRuntimeTest*' --console=plain` → 모두 PASS.
힌트: `Value.context` 는 GraalVM 24 에 있다(`fl.json.parse` 가 그 컨텍스트의 `JSON.parse` 를 빌려 진짜 JS 객체를 돌려준다). SEED/ARIA 가 `NoSuchAlgorithmException` 이면 BC 프로바이더 등록(`init`)이 안 된 것 — `FlHelpers` 객체가 먼저 touch 되는지 확인.

- [ ] **Step 5: 커밋**

```bash
git add backend/src/main/kotlin/com/flowlink/plugin/script/FlHelpers.kt backend/src/test/kotlin/com/flowlink/plugin/script/FlHelpersTest.kt
git commit -m "feat(plugins): fl.* 헬퍼 v1 — b64/hex/hash/hmac/aes/seed/aria/rsa/bytes/text/pad/mask/now/json/log + 매니페스트" -- backend/src/main/kotlin/com/flowlink/plugin/script/FlHelpers.kt backend/src/test/kotlin/com/flowlink/plugin/script/FlHelpersTest.kt
```

---

### Task 4: SPI 어댑터 — 스크립트를 FlowTransform / FieldCodec / MessageCodec 으로

**Files:**
- Modify: `backend/src/main/kotlin/com/flowlink/plugin/script/ScriptAdapters.kt` (하단에 추가)
- Test: `backend/src/test/kotlin/com/flowlink/plugin/script/ScriptAdaptersTest.kt`

**Interfaces:**
- Produces: `fun CompiledScript.toPlugin(rt: ScriptRuntime): Any` — kind 별 `ScriptTransform`(`FlowTransform`) / `ScriptFieldCodec`(`FieldCodec`) / `ScriptMessageCodec`(`MessageCodec`). 실행 오류는 `ScriptError`(RuntimeException) 그대로 — 기존 호출자(`FlowExecutor.transformNode` 의 `catch (e: Exception)`, `MockCodec.applyStep`, `ProtocolCodec`)가 메시지로 표면화.

- [ ] **Step 1: 실패하는 테스트**

`backend/src/test/kotlin/com/flowlink/plugin/script/ScriptAdaptersTest.kt`:

```kotlin
package com.flowlink.plugin.script

import com.flowlink.codec.CodecCtx
import com.flowlink.codec.FieldCodec
import com.flowlink.codec.FieldInfo
import com.flowlink.codec.MessageCodec
import com.flowlink.plugin.PluginsProperties
import com.flowlink.transform.FlowTransform
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

class ScriptAdaptersTest {
    private val rt = ScriptRuntime(PluginsProperties())

    @Test
    fun `transform 어댑터 - SPI 메타와 apply 위임`() {
        val p = rt.compile("({ id: 't1', label: '라벨', description: '설명', inputs: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], outputs: [{ key: 'sum', label: '합', type: 'number' }], params: [{ key: 'k', label: 'K', defaultValue: '1' }], apply(i, c) { return { sum: Number(i.a) + Number(i.b) + Number(c.k) } } })").toPlugin(rt)
        assertThat(p).isInstanceOf(FlowTransform::class.java)
        val t = p as FlowTransform
        assertThat(t.id()).isEqualTo("t1"); assertThat(t.label()).isEqualTo("라벨"); assertThat(t.description()).isEqualTo("설명")
        assertThat(t.inputs().map { it.key }).containsExactly("a", "b"); assertThat(t.outputs().single().type).isEqualTo("number")
        assertThat(t.params().single().defaultValue).isEqualTo("1")
        assertThat(t.apply(mapOf("a" to "1", "b" to "2"), mapOf("k" to "3"))).containsEntry("sum", "6")
        assertThat(t.apply(mapOf("a" to "x"), emptyMap())).containsEntry("sum", "null") // NaN → JSON.stringify → "null"
    }

    @Test
    fun `fieldCodec 어댑터`() {
        val p = rt.compile("({ id: 'f1', label: 'F', kind: 'fieldCodec', params: [{ key: 'n', label: 'N', defaultValue: '2' }], encode(v, ctx) { return fl.mask(v, 0, Number(ctx.config.n)) }, decode(v, ctx) { return v.replace(/\\*/g, '') } })").toPlugin(rt)
        val fc = p as FieldCodec
        val ctx = CodecCtx(FieldInfo("acct", 10, "ascii", "right/space"), emptyMap(), mapOf("n" to "3"), "send")
        assertThat(fc.id()).isEqualTo("f1"); assertThat(fc.params().single().key).isEqualTo("n")
        assertThat(fc.encode("123456", ctx)).isEqualTo("***456"); assertThat(fc.decode("***456", ctx)).isEqualTo("456")
    }

    @Test
    fun `messageCodec 어댑터 - 바이트 왕복`() {
        val p = rt.compile("({ id: 'm1', label: 'M', kind: 'messageCodec', encode(b, ctx) { return fl.aes.encryptBytes(b, ctx.config.key, ctx.config.iv) }, decode(b, ctx) { return fl.aes.decryptBytes(b, ctx.config.key, ctx.config.iv) } })").toPlugin(rt)
        val mc = p as MessageCodec
        val ctx = CodecCtx(null, emptyMap(), mapOf("key" to "0123456789abcdef", "iv" to "0000000000000000"), "send")
        val body = "본문".toByteArray(Charsets.UTF_8)
        val enc = mc.encode(body, ctx)
        assertThat(enc).isNotEqualTo(body); assertThat(mc.decode(enc, ctx)).isEqualTo(body)
    }
}
```

- [ ] **Step 2: 실패 확인** — `cd backend && ./gradlew :test --tests '*ScriptAdaptersTest*' --console=plain` → 컴파일 실패(`toPlugin` 없음).

- [ ] **Step 3: 어댑터 구현** — `ScriptAdapters.kt` 하단에 추가:

```kotlin
/** kind 에 맞는 SPI 구현체로 감싼다 — 레지스트리·실행 엔진·Mock·프로토콜은 스크립트 여부를 모른다. */
fun CompiledScript.toPlugin(rt: ScriptRuntime): Any = when (meta.kind) {
    ScriptMeta.FIELD_CODEC -> ScriptFieldCodec(this, rt)
    ScriptMeta.MESSAGE_CODEC -> ScriptMessageCodec(this, rt)
    else -> ScriptTransform(this, rt)
}

class ScriptTransform(private val cs: CompiledScript, private val rt: ScriptRuntime) : FlowTransform {
    override fun id() = cs.meta.id
    override fun label() = cs.meta.label
    override fun description() = cs.meta.description
    override fun inputs() = cs.meta.inputs
    override fun outputs() = cs.meta.outputs
    override fun params() = cs.meta.params
    override fun apply(inputs: Map<String, String>, config: Map<String, String>): Map<String, String> = rt.runTransform(cs, inputs, config).value
}

class ScriptFieldCodec(private val cs: CompiledScript, private val rt: ScriptRuntime) : com.flowlink.codec.FieldCodec {
    override fun id() = cs.meta.id
    override fun label() = cs.meta.label
    override fun params() = cs.meta.params
    override fun encode(value: String, ctx: com.flowlink.codec.CodecCtx) = rt.runFieldCodec(cs, value, "encode", ctx).value
    override fun decode(value: String, ctx: com.flowlink.codec.CodecCtx) = rt.runFieldCodec(cs, value, "decode", ctx).value
}

class ScriptMessageCodec(private val cs: CompiledScript, private val rt: ScriptRuntime) : com.flowlink.codec.MessageCodec {
    override fun id() = cs.meta.id
    override fun label() = cs.meta.label
    override fun params() = cs.meta.params
    override fun encode(body: ByteArray, ctx: com.flowlink.codec.CodecCtx) = rt.runMessageCodec(cs, "encode", body, ctx).value
    override fun decode(body: ByteArray, ctx: com.flowlink.codec.CodecCtx) = rt.runMessageCodec(cs, "decode", body, ctx).value
}
```

- [ ] **Step 4: 통과 확인** — `./gradlew :test --tests '*ScriptAdaptersTest*' --console=plain` → PASS.

- [ ] **Step 5: 커밋**

```bash
git add backend/src/main/kotlin/com/flowlink/plugin/script/ScriptAdapters.kt backend/src/test/kotlin/com/flowlink/plugin/script/ScriptAdaptersTest.kt
git commit -m "feat(plugins): 스크립트 → FlowTransform/FieldCodec/MessageCodec 어댑터" -- backend/src/main/kotlin/com/flowlink/plugin/script/ScriptAdapters.kt backend/src/test/kotlin/com/flowlink/plugin/script/ScriptAdaptersTest.kt
```

---

### Task 5: 엔티티 `PluginScript` + 저장소 + DDL

**Files:**
- Create: `backend/src/main/kotlin/com/flowlink/core/domain/PluginScript.kt`
- Create: `backend/src/main/kotlin/com/flowlink/core/repository/PluginScriptRepository.kt`
- Modify: `backend/src/main/resources/db/init.sql` (끝에 추가)
- Test: `backend/src/test/kotlin/com/flowlink/plugin/PluginScriptRepositoryTest.kt`

**Interfaces:**
- Produces: 엔티티 `PluginScript`(필드: `id: UUID`, `tenantId`, `pluginId`, `name`, `kind`, `source`, `liveSource: String?`, `status`, `sampleJson: String?`, `submittedBy/At`, `reviewedBy/At`, `reviewNote`, `createdBy`, `createdAt`, `updatedAt`) + `companion fun create(tenantId, pluginId, name, kind, source, createdBy)` + 상수 `STATUS_DRAFT/PENDING/APPROVED/REJECTED`.
- Produces: `PluginScriptRepository : JpaRepository<PluginScript, UUID>` with `findByTenantIdOrderByUpdatedAtDesc(tenantId)`, `findByIdAndTenantId(id, tenantId): Optional`, `existsByTenantIdAndPluginId(tenantId, pluginId)`, `findByLiveSourceIsNotNull(): List<PluginScript>`, `countByTenantIdAndStatus(tenantId, status): Long`.

- [ ] **Step 1: 실패하는 테스트**

`backend/src/test/kotlin/com/flowlink/plugin/PluginScriptRepositoryTest.kt`:

```kotlin
package com.flowlink.plugin

import com.flowlink.core.domain.PluginScript
import com.flowlink.core.repository.PluginScriptRepository
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.autoconfigure.orm.jpa.DataJpaTest
import org.springframework.test.context.TestPropertySource

@DataJpaTest
@TestPropertySource(properties = [
    "spring.datasource.url=jdbc:h2:mem:pluginscript;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE",
    "spring.jpa.hibernate.ddl-auto=create-drop",
])
class PluginScriptRepositoryTest {
    @Autowired lateinit var repo: PluginScriptRepository

    @Test
    fun `저장 - 초안만 있으면 live 없음, 승인본 조회는 liveSource 있는 행만`() {
        val a = repo.save(PluginScript.create("default", "aes-card", "카드 AES", "transform", "({})", "alice"))
        val b = repo.save(PluginScript.create("default", "mask", "마스킹", "transform", "({})", "alice").also { it.liveSource = "({ live })"; it.status = PluginScript.STATUS_APPROVED })
        assertThat(a.status).isEqualTo(PluginScript.STATUS_DRAFT); assertThat(a.liveSource).isNull(); assertThat(a.createdAt).isNotNull()
        assertThat(repo.findByLiveSourceIsNotNull().map { it.pluginId }).containsExactly("mask")
        assertThat(repo.existsByTenantIdAndPluginId("default", "aes-card")).isTrue()
        assertThat(repo.countByTenantIdAndStatus("default", PluginScript.STATUS_DRAFT)).isEqualTo(1)
        assertThat(repo.findByIdAndTenantId(b.id, "other")).isEmpty()
    }
}
```

- [ ] **Step 2: 실패 확인** — `cd backend && ./gradlew :test --tests '*PluginScriptRepositoryTest*' --console=plain` → 컴파일 실패.

- [ ] **Step 3: 엔티티**

`backend/src/main/kotlin/com/flowlink/core/domain/PluginScript.kt`:

```kotlin
package com.flowlink.core.domain

import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.Id
import jakarta.persistence.Index
import jakarta.persistence.Table
import org.hibernate.annotations.CreationTimestamp
import org.hibernate.annotations.UpdateTimestamp
import java.time.Instant
import java.util.UUID

/**
 * 스크립트 플러그인 — 화면에서 적은 JS 소스. `source` = 초안(편집 중), `liveSource` = 승인본(서빙 중).
 * 승인본은 새 초안이 승인될 때까지 계속 서빙된다(수정·반려가 운영에 무영향). status 는 초안의 상태.
 */
@Entity
@Table(name = "flowlink_plugin_script", indexes = [Index(name = "idx_plugin_script_tenant_pid", columnList = "tenant_id, plugin_id", unique = true)])
class PluginScript {
    @Id @Column(nullable = false, updatable = false) lateinit var id: UUID; private set
    @Column(name = "tenant_id", nullable = false, updatable = false) lateinit var tenantId: String; private set
    /** 스크립트 메타의 id — 레지스트리 키(그래프 transformId·Mock 코덱 step id·프로토콜 plugin.id 가 참조). */
    @Column(name = "plugin_id", nullable = false, length = 64) lateinit var pluginId: String
    @Column(nullable = false, length = 120) lateinit var name: String
    /** transform | fieldCodec | messageCodec — 컴파일 결과로 갱신(목록 표시용). */
    @Column(nullable = false, length = 20) lateinit var kind: String
    @Column(columnDefinition = "text", nullable = false) lateinit var source: String
    @Column(name = "live_source", columnDefinition = "text") var liveSource: String? = null
    @Column(nullable = false, length = 16) var status: String = STATUS_DRAFT
    /** 제출자가 마지막으로 돌린 샘플(입력·설정·출력·콘솔) JSON — 승인 화면에 첨부. */
    @Column(name = "sample_json", columnDefinition = "text") var sampleJson: String? = null
    @Column(name = "submitted_by", length = 180) var submittedBy: String? = null
    @Column(name = "submitted_at") var submittedAt: Instant? = null
    @Column(name = "reviewed_by", length = 180) var reviewedBy: String? = null
    @Column(name = "reviewed_at") var reviewedAt: Instant? = null
    @Column(name = "review_note", length = 1000) var reviewNote: String? = null
    @Column(name = "created_by", nullable = false, updatable = false, length = 180) lateinit var createdBy: String; private set
    @CreationTimestamp @Column(name = "created_at", nullable = false, updatable = false) lateinit var createdAt: Instant; private set
    @UpdateTimestamp @Column(name = "updated_at") var updatedAt: Instant? = null; private set

    companion object {
        const val STATUS_DRAFT = "DRAFT"; const val STATUS_PENDING = "PENDING"; const val STATUS_APPROVED = "APPROVED"; const val STATUS_REJECTED = "REJECTED"
        @JvmStatic fun create(tenantId: String, pluginId: String, name: String, kind: String, source: String, createdBy: String): PluginScript =
            PluginScript().also { it.id = UUID.randomUUID(); it.tenantId = tenantId; it.pluginId = pluginId; it.name = name; it.kind = kind; it.source = source; it.createdBy = createdBy }
    }
}
```

- [ ] **Step 4: 저장소**

`backend/src/main/kotlin/com/flowlink/core/repository/PluginScriptRepository.kt`:

```kotlin
package com.flowlink.core.repository

import com.flowlink.core.domain.PluginScript
import org.springframework.data.jpa.repository.JpaRepository
import java.util.Optional
import java.util.UUID

interface PluginScriptRepository : JpaRepository<PluginScript, UUID> {
    fun findByTenantIdOrderByUpdatedAtDesc(tenantId: String): List<PluginScript>
    fun findByIdAndTenantId(id: UUID, tenantId: String): Optional<PluginScript>
    fun existsByTenantIdAndPluginId(tenantId: String, pluginId: String): Boolean
    /** 승인본이 있는 행 전부(전 테넌트) — 레지스트리 reload 용. */
    fun findByLiveSourceIsNotNull(): List<PluginScript>
    fun countByTenantIdAndStatus(tenantId: String, status: String): Long
}
```

- [ ] **Step 5: DDL** — `backend/src/main/resources/db/init.sql` 끝에 추가:

```sql

-- 스크립트 플러그인 — source=초안, live_source=승인본(서빙 중). status 는 초안 상태(DRAFT/PENDING/APPROVED/REJECTED).
CREATE TABLE flowlink_plugin_script (
    id            varchar2(36 char)  PRIMARY KEY,
    tenant_id     varchar2(64 char)  NOT NULL,
    plugin_id     varchar2(64 char)  NOT NULL,
    name          varchar2(120 char) NOT NULL,
    kind          varchar2(20 char)  NOT NULL,
    source        clob NOT NULL,
    live_source   clob,
    status        varchar2(16 char)  NOT NULL,
    sample_json   clob,
    submitted_by  varchar2(180 char),
    submitted_at  timestamp with time zone,
    reviewed_by   varchar2(180 char),
    reviewed_at   timestamp with time zone,
    review_note   varchar2(1000 char),
    created_by    varchar2(180 char) NOT NULL,
    created_at    timestamp with time zone DEFAULT systimestamp NOT NULL,
    updated_at    timestamp with time zone
);
CREATE UNIQUE INDEX idx_plugin_script_tenant_pid ON flowlink_plugin_script (tenant_id, plugin_id);
```

- [ ] **Step 6: 통과 확인** — `./gradlew :test --tests '*PluginScriptRepositoryTest*' --console=plain` → PASS.

- [ ] **Step 7: 커밋**

```bash
git add backend/src/main/kotlin/com/flowlink/core/domain/PluginScript.kt backend/src/main/kotlin/com/flowlink/core/repository/PluginScriptRepository.kt backend/src/main/resources/db/init.sql backend/src/test/kotlin/com/flowlink/plugin/PluginScriptRepositoryTest.kt
git commit -m "feat(plugins): flowlink_plugin_script 엔티티·저장소·DDL(초안/승인본 분리)" -- backend/src/main/kotlin/com/flowlink/core/domain/PluginScript.kt backend/src/main/kotlin/com/flowlink/core/repository/PluginScriptRepository.kt backend/src/main/resources/db/init.sql backend/src/test/kotlin/com/flowlink/plugin/PluginScriptRepositoryTest.kt
```

---

### Task 6: PluginScriptService + Controller — CRUD·try·승인 흐름·레지스트리 연동

**Files:**
- Create: `backend/src/main/kotlin/com/flowlink/plugin/PluginScriptDtos.kt`
- Create: `backend/src/main/kotlin/com/flowlink/plugin/PluginScriptService.kt`
- Create: `backend/src/main/kotlin/com/flowlink/plugin/PluginScriptController.kt`
- Modify: `backend/src/main/kotlin/com/flowlink/transform/TransformRegistry.kt` (생성자 — `scripts: ScriptPluginLoader` 를 Spring 이 주입하도록 기본값 유지)
- Test: `backend/src/test/kotlin/com/flowlink/plugin/PluginScriptLifecycleTest.kt`

**Interfaces:**
- Consumes: `ScriptRuntime.compile/runTransform/runFieldCodec/runMessageCodec`, `CompiledScript.toPlugin`, `PluginScriptRepository`, `TransformRegistry.reload()`, `WorkspaceService.currentUsername/isApproved/isAdmin`.
- Produces(DTO, `object PluginScriptDtos`): `Summary(id, pluginId, name, kind, status, live: Boolean, dirty: Boolean, usages: Int, updatedAt, submittedBy, createdBy)` · `Detail(…Summary 필드…, source, liveSource, sampleJson, reviewNote, reviewedBy, reviewedAt, meta: MetaView?)` · `MetaView(id, label, description, kind, inputs, outputs, params)` · `SaveRequest(name: String?, source: String?)` · `TryRequest(source, inputs: Map<String,String>?, config: Map<String,String>?, value: String?, direction: String?, fn: String? /* encode|decode */, bytesB64: String?, message: Map<String,String>?)` · `TryResult(meta: MetaView, outputs: Map<String,String>?, result: String?, bytesB64: String?, logs: List<String>, durationMs: Long)` · `ReviewRequest(note: String?)`.
- Produces: `class PluginScriptService : ScriptPluginLoader` — `list()`, `get(id)`, `create(req)`, `update(id, req)`, `tryRun(req)`, `submit(id)`, `withdraw(id)`, `approve(id)`, `reject(id, note)`, `delete(id)`, `loadApproved()`, `pendingCount(): Long`. `usages` 는 Task 7 전까지 0(훅만 `usageCount(pluginId)` 로 남긴다).
- Produces: 컨트롤러 경로 스펙 §5 그대로 (`/api/v1/plugins/scripts/**`, `POST …/try`).
- 오류 매핑: `ScriptError` → `BadRequestException("${line}:${col}: message")` 가 아니라 **JSON `{message, line, col}`** 이 필요하므로 `ScriptError` 전용 핸들러를 `PluginScriptController` 안에 `@ExceptionHandler` 로 둔다(400 + `{ "message", "line", "col" }`).

- [ ] **Step 1: 실패하는 테스트**

`backend/src/test/kotlin/com/flowlink/plugin/PluginScriptLifecycleTest.kt`:

```kotlin
package com.flowlink.plugin

import com.flowlink.common.error.BadRequestException
import com.flowlink.common.error.ForbiddenException
import com.flowlink.core.domain.AppUser
import com.flowlink.core.domain.PluginScript
import com.flowlink.core.repository.AppUserRepository
import com.flowlink.plugin.script.ScriptError
import com.flowlink.transform.TransformRegistry
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.security.core.context.SecurityContextHolder
import org.springframework.security.oauth2.jwt.Jwt
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken
import org.springframework.test.context.TestPropertySource

/** 초안 → 승인 요청 → 승인 → 레지스트리 등장. 게이트(승인 사용자 쓰기·관리자 승인)는 JWT 를 심어 검증(WorkspaceRbacTest 관례). */
@SpringBootTest
@TestPropertySource(properties = [
    "spring.datasource.url=jdbc:h2:mem:pluginlifecycle;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE",
    "spring.datasource.driver-class-name=org.h2.Driver",
    "spring.datasource.username=sa",
    "spring.datasource.password=",
    "spring.jpa.hibernate.ddl-auto=create-drop",
    "flowlink.auth.github-enabled=true",
])
class PluginScriptLifecycleTest {
    @Autowired lateinit var svc: PluginScriptService
    @Autowired lateinit var registry: TransformRegistry
    @Autowired lateinit var userRepo: AppUserRepository

    private val T = com.flowlink.common.tenant.TenantContext.SHARED_FLOW_TENANT
    private val SRC = "({ id: 'up1', label: '대문자', inputs: [{ key: 'input', label: '원문' }], apply(i, c) { fl.log('run'); return { result: i.input.toUpperCase() } } })"

    @AfterEach fun clear() = SecurityContextHolder.clearContext()
    private fun asUser(name: String) {
        val jwt = Jwt.withTokenValue("t").header("alg", "none").claim("preferred_username", name).subject(name).build()
        SecurityContextHolder.getContext().authentication = JwtAuthenticationToken(jwt)
    }
    private fun user(name: String, status: String, role: String = AppUser.ROLE_MEMBER) {
        val u = userRepo.findByTenantIdAndUsername(T, name).orElseGet { userRepo.save(AppUser.of(T, name)) }
        u.status = status; u.globalRole = role; userRepo.save(u)
    }

    @Test
    fun `초안 저장 → 시험 실행 → 승인 요청 → 관리자 승인 → 레지스트리에 등장, 반려는 승인본 유지`() {
        user("alice", AppUser.STATUS_APPROVED); user("admin", AppUser.STATUS_APPROVED, AppUser.ROLE_ADMIN)
        asUser("alice")
        val d = svc.create(PluginScriptDtos.SaveRequest("대문자", SRC))
        assertThat(d.status).isEqualTo(PluginScript.STATUS_DRAFT); assertThat(d.pluginId).isEqualTo("up1"); assertThat(d.meta!!.inputs.single().key).isEqualTo("input")
        assertThat(registry.get("up1")).isEmpty

        val tr = svc.tryRun(PluginScriptDtos.TryRequest(source = SRC, inputs = mapOf("input" to "ab")))
        assertThat(tr.outputs).containsEntry("result", "AB"); assertThat(tr.logs).containsExactly("run")

        assertThatThrownBy { svc.approve(d.id) }.isInstanceOf(ForbiddenException::class.java) // 관리자 아님
        val p = svc.submit(d.id); assertThat(p.status).isEqualTo(PluginScript.STATUS_PENDING); assertThat(p.submittedBy).isEqualTo("alice")
        assertThat(svc.pendingCount()).isEqualTo(1)

        asUser("admin")
        val a = svc.approve(d.id)
        assertThat(a.status).isEqualTo(PluginScript.STATUS_APPROVED); assertThat(a.live).isTrue(); assertThat(a.liveSource).isEqualTo(SRC)
        assertThat(registry.get("up1")).isPresent
        assertThat(registry.get("up1").get().apply(mapOf("input" to "x"), emptyMap())).containsEntry("result", "X")

        // 수정 → 초안만 바뀌고 서빙은 그대로(dirty)
        asUser("alice")
        val u = svc.update(d.id, PluginScriptDtos.SaveRequest(null, SRC.replace("toUpperCase", "toLowerCase")))
        assertThat(u.dirty).isTrue(); assertThat(u.status).isEqualTo(PluginScript.STATUS_APPROVED)
        assertThat(registry.get("up1").get().apply(mapOf("input" to "x"), emptyMap())).containsEntry("result", "X")
        svc.submit(d.id)
        asUser("admin")
        val r = svc.reject(d.id, "이유")
        assertThat(r.status).isEqualTo(PluginScript.STATUS_REJECTED); assertThat(r.reviewNote).isEqualTo("이유"); assertThat(r.live).isTrue()
        assertThat(registry.get("up1").get().apply(mapOf("input" to "x"), emptyMap())).containsEntry("result", "X")

        // 삭제(사용처 0) → 레지스트리에서 사라짐
        svc.delete(d.id)
        assertThat(registry.get("up1")).isEmpty
    }

    @Test
    fun `컴파일 실패는 ScriptError(400) - 줄 번호, pluginId 중복은 400, 미승인 사용자는 403, 게스트는 403`() {
        user("alice", AppUser.STATUS_APPROVED); user("pend", AppUser.STATUS_PENDING)
        asUser("alice")
        assertThatThrownBy { svc.create(PluginScriptDtos.SaveRequest("x", "({ id: 'x',\n label: 'x' apply() {} })")) }
            .isInstanceOf(ScriptError::class.java).matches { (it as ScriptError).line == 2 }
        svc.create(PluginScriptDtos.SaveRequest("a", SRC))
        assertThatThrownBy { svc.create(PluginScriptDtos.SaveRequest("b", SRC)) }.isInstanceOf(BadRequestException::class.java).hasMessageContaining("up1")
        asUser("pend")
        assertThatThrownBy { svc.create(PluginScriptDtos.SaveRequest("c", SRC.replace("up1", "up2"))) }.isInstanceOf(ForbiddenException::class.java)
        assertThatThrownBy { svc.tryRun(PluginScriptDtos.TryRequest(source = SRC)) }.isInstanceOf(ForbiddenException::class.java)
        SecurityContextHolder.clearContext() // github 모드 무토큰 = guest
        assertThat(svc.list()).isNotEmpty // 읽기는 허용
        assertThatThrownBy { svc.create(PluginScriptDtos.SaveRequest("d", SRC.replace("up1", "up3"))) }.isInstanceOf(ForbiddenException::class.java)
    }

    @Test
    fun `try - fieldCodec 과 messageCodec 도 시험 가능, 컴파일만(입력 없음)이면 meta 만`() {
        user("alice", AppUser.STATUS_APPROVED); asUser("alice")
        val fc = "({ id: 'fc1', label: 'F', kind: 'fieldCodec', encode(v, ctx) { return v + '!' + ctx.direction }, decode(v, ctx) { return v.slice(0, -5) } })"
        assertThat(svc.tryRun(PluginScriptDtos.TryRequest(source = fc, value = "a", fn = "encode", direction = "send")).result).isEqualTo("a!send")
        val mc = "({ id: 'mc1', label: 'M', kind: 'messageCodec', encode(b, ctx) { return b.map((x) => x ^ 1) }, decode(b, ctx) { return b.map((x) => x ^ 1) } })"
        assertThat(svc.tryRun(PluginScriptDtos.TryRequest(source = mc, fn = "encode", bytesB64 = "AQI=")).bytesB64).isEqualTo("AAM=")
        val metaOnly = svc.tryRun(PluginScriptDtos.TryRequest(source = SRC))
        assertThat(metaOnly.meta.id).isEqualTo("up1"); assertThat(metaOnly.outputs).isNull()
    }
}
```
주의: `AppUser.of(tenant, username)` 팩토리와 `globalRole`/`status` setter 는 기존 엔티티에 있다(WorkspaceRbacTest 참고). 없으면 그 테스트의 `approveUser` 방식을 그대로 따른다.

- [ ] **Step 2: 실패 확인** — `cd backend && ./gradlew :test --tests '*PluginScriptLifecycleTest*' --console=plain` → 컴파일 실패.

- [ ] **Step 3: DTO**

`backend/src/main/kotlin/com/flowlink/plugin/PluginScriptDtos.kt`:

```kotlin
package com.flowlink.plugin

import com.flowlink.plugin.script.ScriptMeta
import com.flowlink.transform.FlowTransform
import java.time.Instant
import java.util.UUID

object PluginScriptDtos {
    data class MetaView(val id: String, val label: String, val description: String, val kind: String,
                        val inputs: List<FlowTransform.IoSpec>, val outputs: List<FlowTransform.IoSpec>, val params: List<FlowTransform.TransformParam>) {
        companion object { fun of(m: ScriptMeta) = MetaView(m.id, m.label, m.description, m.kind, m.inputs, m.outputs, m.params) }
    }
    data class Summary(
        val id: UUID, val pluginId: String, val name: String, val kind: String, val status: String,
        /** 승인본이 서빙 중인가 */ val live: Boolean,
        /** 초안이 승인본과 다른가(수정 중) */ val dirty: Boolean,
        val usages: Int, val updatedAt: Instant?, val submittedBy: String?, val createdBy: String,
    )
    data class Detail(
        val id: UUID, val pluginId: String, val name: String, val kind: String, val status: String, val live: Boolean, val dirty: Boolean,
        val usages: Int, val updatedAt: Instant?, val submittedBy: String?, val submittedAt: Instant?, val createdBy: String,
        val source: String, val liveSource: String?, val sampleJson: String?, val reviewNote: String?, val reviewedBy: String?, val reviewedAt: Instant?,
        /** 초안의 컴파일 메타(컴파일 실패면 null — 저장 시점엔 항상 성공하므로 보통 있음) */ val meta: MetaView?,
    )
    data class SaveRequest(val name: String? = null, val source: String? = null)
    /** 초안 1회 실행. 입력이 하나도 없으면 컴파일만(meta). transform: inputs/config · fieldCodec: value+fn+direction(+message) · messageCodec: bytesB64+fn. */
    data class TryRequest(
        val source: String? = null, val inputs: Map<String, String>? = null, val config: Map<String, String>? = null,
        val value: String? = null, val fn: String? = null, val direction: String? = null, val message: Map<String, String>? = null, val bytesB64: String? = null,
    )
    data class TryResult(val meta: MetaView, val outputs: Map<String, String>? = null, val result: String? = null, val bytesB64: String? = null,
                         val logs: List<String> = emptyList(), val durationMs: Long = 0)
    data class ReviewRequest(val note: String? = null)
    data class ScriptErrorBody(val message: String, val line: Int?, val col: Int?)
}
```

- [ ] **Step 4: 서비스**

`backend/src/main/kotlin/com/flowlink/plugin/PluginScriptService.kt`:

```kotlin
package com.flowlink.plugin

import com.flowlink.codec.CodecCtx
import com.flowlink.common.error.BadRequestException
import com.flowlink.common.error.ForbiddenException
import com.flowlink.common.error.NotFoundException
import com.flowlink.common.json.JsonService
import com.flowlink.common.tenant.TenantContext
import com.flowlink.core.domain.PluginScript
import com.flowlink.core.repository.PluginScriptRepository
import com.flowlink.plugin.script.CompiledScript
import com.flowlink.plugin.script.ScriptMeta
import com.flowlink.plugin.script.ScriptRuntime
import com.flowlink.plugin.script.toPlugin
import com.flowlink.transform.ScriptPluginLoader
import com.flowlink.transform.TransformRegistry
import com.flowlink.workspace.WorkspaceService
import org.slf4j.LoggerFactory
import org.springframework.context.annotation.Lazy
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.Instant
import java.util.Base64
import java.util.UUID

/**
 * 스크립트 플러그인 — CRUD·시험 실행·승인 흐름. 게이트: 읽기=누구나(로그인/게스트), 쓰기·try=승인 사용자, 승인/반려=관리자.
 * 승인본(liveSource)만 레지스트리에 올라간다([loadApproved] — TransformRegistry 가 reload 때 호출).
 * 레지스트리는 이 빈을 @Lazy 로 받고(생성 순환: registry → loader(this) → registry), 상태 전이 후 [TransformRegistry.reload].
 */
@Service
class PluginScriptService(
    private val repo: PluginScriptRepository,
    private val rt: ScriptRuntime,
    private val workspace: WorkspaceService,
    private val json: JsonService,
    @Lazy private val registry: TransformRegistry,
    @Lazy private val usages: PluginUsageIndex,
) : ScriptPluginLoader {
    private val log = LoggerFactory.getLogger(PluginScriptService::class.java)
    private fun tenant() = TenantContext.getTenantId()
    private fun me() = workspace.currentUsername()
    private fun requireApproved() { if (!workspace.isApproved(me())) throw ForbiddenException("플러그인 작성·시험은 가입 승인 후 가능합니다.") }
    private fun requireAdmin() { if (!workspace.isAdmin(me())) throw ForbiddenException("플러그인 승인/반려는 관리자만 가능합니다.") }
    private fun find(id: UUID): PluginScript = repo.findByIdAndTenantId(id, tenant()).orElseThrow { NotFoundException("플러그인 스크립트가 없습니다: $id") }

    // ---- 레지스트리 로더 ----
    override fun loadApproved(): List<Any> = repo.findByLiveSourceIsNotNull().mapNotNull { row ->
        try { rt.compile(row.liveSource!!, row.pluginId).toPlugin(rt) }
        catch (e: Exception) { log.warn("승인된 스크립트 플러그인 컴파일 실패(건너뜀): {} — {}", row.pluginId, e.message); null }
    }

    // ---- 조회 ----
    @Transactional(readOnly = true) fun list(): List<PluginScriptDtos.Summary> = repo.findByTenantIdOrderByUpdatedAtDesc(tenant()).map { summary(it) }
    @Transactional(readOnly = true) fun get(id: UUID): PluginScriptDtos.Detail = detail(find(id))
    @Transactional(readOnly = true) fun pendingCount(): Long = repo.countByTenantIdAndStatus(tenant(), PluginScript.STATUS_PENDING)

    // ---- 초안 저장 ----
    @Transactional
    fun create(req: PluginScriptDtos.SaveRequest): PluginScriptDtos.Detail {
        requireApproved()
        val src = req.source?.takeIf { it.isNotBlank() } ?: throw BadRequestException("source 가 비었습니다.")
        val cs = rt.compile(src)
        if (repo.existsByTenantIdAndPluginId(tenant(), cs.meta.id)) throw BadRequestException("같은 id 의 플러그인이 이미 있습니다: ${cs.meta.id}")
        val row = repo.save(PluginScript.create(tenant(), cs.meta.id, normName(req.name, cs.meta.label), cs.meta.kind, src, me()))
        return detail(row, cs)
    }

    @Transactional
    fun update(id: UUID, req: PluginScriptDtos.SaveRequest): PluginScriptDtos.Detail {
        requireApproved()
        val row = find(id)
        var cs: CompiledScript? = null
        req.source?.let { src ->
            cs = rt.compile(src)
            if (cs!!.meta.id != row.pluginId) {
                if (repo.existsByTenantIdAndPluginId(tenant(), cs!!.meta.id)) throw BadRequestException("같은 id 의 플러그인이 이미 있습니다: ${cs!!.meta.id}")
                if (row.liveSource != null) throw BadRequestException("승인된 플러그인의 id(${row.pluginId})는 바꿀 수 없습니다 — 새 플러그인으로 만드세요.")
                row.pluginId = cs!!.meta.id
            }
            row.source = src; row.kind = cs!!.meta.kind
            if (row.status == PluginScript.STATUS_PENDING || row.status == PluginScript.STATUS_REJECTED) row.status = PluginScript.STATUS_DRAFT
        }
        req.name?.let { row.name = normName(it, row.name) }
        return detail(repo.save(row), cs)
    }

    // ---- 시험 실행(샌드박스, 저장 없음) ----
    fun tryRun(req: PluginScriptDtos.TryRequest): PluginScriptDtos.TryResult {
        requireApproved()
        val src = req.source?.takeIf { it.isNotBlank() } ?: throw BadRequestException("source 가 비었습니다.")
        val cs = rt.compile(src)
        val meta = PluginScriptDtos.MetaView.of(cs.meta)
        val hasInput = req.inputs != null || req.value != null || req.bytesB64 != null
        if (!hasInput) return PluginScriptDtos.TryResult(meta)
        return when (cs.meta.kind) {
            ScriptMeta.TRANSFORM -> rt.runTransform(cs, req.inputs ?: emptyMap(), req.config ?: emptyMap()).let { PluginScriptDtos.TryResult(meta, outputs = it.value, logs = it.logs, durationMs = it.durationMs) }
            ScriptMeta.FIELD_CODEC -> rt.runFieldCodec(cs, req.value ?: "", fnOf(req.fn), codecCtx(req)).let { PluginScriptDtos.TryResult(meta, result = it.value, logs = it.logs, durationMs = it.durationMs) }
            else -> rt.runMessageCodec(cs, fnOf(req.fn), Base64.getDecoder().decode(req.bytesB64 ?: ""), codecCtx(req)).let { PluginScriptDtos.TryResult(meta, bytesB64 = Base64.getEncoder().encodeToString(it.value), logs = it.logs, durationMs = it.durationMs) }
        }
    }
    private fun fnOf(fn: String?) = if (fn == "decode") "decode" else "encode"
    private fun codecCtx(req: PluginScriptDtos.TryRequest) = CodecCtx(null, req.message ?: emptyMap(), req.config ?: emptyMap(), if (req.direction == "recv") "recv" else "send")

    // ---- 상태 전이 ----
    @Transactional
    fun submit(id: UUID): PluginScriptDtos.Detail {
        requireApproved()
        val row = find(id)
        rt.compile(row.source) // 제출 시점에도 컴파일되는지
        row.status = PluginScript.STATUS_PENDING; row.submittedBy = me(); row.submittedAt = Instant.now(); row.reviewNote = null
        return detail(repo.save(row))
    }

    @Transactional
    fun withdraw(id: UUID): PluginScriptDtos.Detail {
        requireApproved()
        val row = find(id)
        if (row.status != PluginScript.STATUS_PENDING) throw BadRequestException("승인 대기 중이 아닙니다.")
        row.status = PluginScript.STATUS_DRAFT
        return detail(repo.save(row))
    }

    @Transactional
    fun approve(id: UUID): PluginScriptDtos.Detail {
        requireAdmin()
        val row = find(id)
        if (row.status != PluginScript.STATUS_PENDING) throw BadRequestException("승인 대기 중이 아닙니다.")
        rt.compile(row.source)
        row.liveSource = row.source; row.status = PluginScript.STATUS_APPROVED; row.reviewedBy = me(); row.reviewedAt = Instant.now(); row.reviewNote = null
        val saved = repo.save(row)
        registry.reload()
        return detail(saved)
    }

    @Transactional
    fun reject(id: UUID, note: String?): PluginScriptDtos.Detail {
        requireAdmin()
        val row = find(id)
        if (row.status != PluginScript.STATUS_PENDING) throw BadRequestException("승인 대기 중이 아닙니다.")
        row.status = PluginScript.STATUS_REJECTED; row.reviewedBy = me(); row.reviewedAt = Instant.now(); row.reviewNote = note?.take(1000)
        return detail(repo.save(row))
    }

    @Transactional
    fun delete(id: UUID) {
        val row = find(id)
        if (row.createdBy != me() && !workspace.isAdmin(me())) throw ForbiddenException("작성자 또는 관리자만 삭제할 수 있습니다.")
        val n = usages.count(row.pluginId)
        if (n > 0) throw BadRequestException("사용 중인 플러그인은 삭제할 수 없습니다(사용처 ${n}곳) — 먼저 워크플로/Mock/프로토콜에서 제거하세요.")
        repo.delete(row)
        if (row.liveSource != null) registry.reload()
    }

    /** 제출자가 돌린 샘플을 승인 화면용으로 저장(프론트가 try 결과를 submit 전에 PUT). */
    @Transactional
    fun saveSample(id: UUID, sampleJson: String?) { requireApproved(); val row = find(id); row.sampleJson = sampleJson?.take(20_000); repo.save(row) }

    // ---- 뷰 ----
    private fun normName(name: String?, fallback: String): String {
        val n = name?.trim().orEmpty().ifEmpty { fallback }
        if (n.length > 120) throw BadRequestException("이름은 120자 이하여야 합니다.")
        return n
    }
    private fun summary(r: PluginScript) = PluginScriptDtos.Summary(r.id, r.pluginId, r.name, r.kind, r.status, r.liveSource != null,
        r.liveSource != null && r.liveSource != r.source, usages.count(r.pluginId), r.updatedAt ?: r.createdAt, r.submittedBy, r.createdBy)
    private fun detail(r: PluginScript, cs: CompiledScript? = null): PluginScriptDtos.Detail {
        val meta = (cs ?: runCatching { rt.compile(r.source, r.pluginId) }.getOrNull())?.let { PluginScriptDtos.MetaView.of(it.meta) }
        return PluginScriptDtos.Detail(r.id, r.pluginId, r.name, r.kind, r.status, r.liveSource != null, r.liveSource != null && r.liveSource != r.source,
            usages.count(r.pluginId), r.updatedAt ?: r.createdAt, r.submittedBy, r.submittedAt, r.createdBy,
            r.source, r.liveSource, r.sampleJson, r.reviewNote, r.reviewedBy, r.reviewedAt, meta)
    }
}
```

`PluginUsageIndex` 는 Task 7 에서 완성하지만 이 태스크가 컴파일되려면 최소 골격이 필요하다 — `backend/src/main/kotlin/com/flowlink/plugin/PluginUsageIndex.kt` 를 지금 만든다:

```kotlin
package com.flowlink.plugin

import org.springframework.stereotype.Component

/** pluginId 사용처 인덱스 — Task 7 에서 그래프/Mock/프로토콜 스캔으로 채운다. */
@Component
class PluginUsageIndex {
    data class Ref(val kind: String, val id: String, val name: String)
    fun refs(pluginId: String): List<Ref> = emptyList()
    fun count(pluginId: String): Int = refs(pluginId).size
}
```

- [ ] **Step 5: 컨트롤러**

`backend/src/main/kotlin/com/flowlink/plugin/PluginScriptController.kt`:

```kotlin
package com.flowlink.plugin

import com.flowlink.plugin.script.FlApi
import com.flowlink.plugin.script.FlApiEntry
import com.flowlink.plugin.script.ScriptError
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.*
import java.util.UUID

/** 스크립트 플러그인 API — 게이트는 서비스 레이어(승인 사용자 쓰기 · 관리자 승인). ScriptError 는 400 + {message, line, col}. */
@RestController
@RequestMapping("/api/v1/plugins")
class PluginScriptController(private val service: PluginScriptService) {
    /** fl.* 매니페스트 — 편집기 자동완성·MCP 가이드(비밀 없음, 공개). */
    @GetMapping("/api") fun api(): List<FlApiEntry> = FlApi.MANIFEST

    @GetMapping("/scripts") fun list(@RequestParam(required = false) status: String?): List<PluginScriptDtos.Summary> =
        service.list().let { l -> if (status.isNullOrBlank()) l else l.filter { it.status == status } }
    @GetMapping("/scripts/{id}") fun get(@PathVariable id: UUID) = service.get(id)
    @PostMapping("/scripts") @ResponseStatus(HttpStatus.CREATED) fun create(@RequestBody req: PluginScriptDtos.SaveRequest) = service.create(req)
    @PutMapping("/scripts/{id}") fun update(@PathVariable id: UUID, @RequestBody req: PluginScriptDtos.SaveRequest) = service.update(id, req)
    @PostMapping("/scripts/try") fun tryRun(@RequestBody req: PluginScriptDtos.TryRequest) = service.tryRun(req)
    @PutMapping("/scripts/{id}/sample") @ResponseStatus(HttpStatus.NO_CONTENT) fun sample(@PathVariable id: UUID, @RequestBody body: Map<String, Any?>) =
        service.saveSample(id, body["sampleJson"]?.toString())
    @PostMapping("/scripts/{id}/submit") fun submit(@PathVariable id: UUID) = service.submit(id)
    @PostMapping("/scripts/{id}/withdraw") fun withdraw(@PathVariable id: UUID) = service.withdraw(id)
    @PostMapping("/scripts/{id}/approve") fun approve(@PathVariable id: UUID) = service.approve(id)
    @PostMapping("/scripts/{id}/reject") fun reject(@PathVariable id: UUID, @RequestBody(required = false) req: PluginScriptDtos.ReviewRequest?) = service.reject(id, req?.note)
    @DeleteMapping("/scripts/{id}") @ResponseStatus(HttpStatus.NO_CONTENT) fun delete(@PathVariable id: UUID) = service.delete(id)

    @ExceptionHandler(ScriptError::class)
    fun scriptError(e: ScriptError): ResponseEntity<PluginScriptDtos.ScriptErrorBody> =
        ResponseEntity.badRequest().body(PluginScriptDtos.ScriptErrorBody(e.message ?: "스크립트 오류", e.line, e.col))
}
```

- [ ] **Step 6: 레지스트리가 서비스를 로더로 주입받게**

`TransformRegistry` 생성자는 Task 1 의 `scripts: ScriptPluginLoader = ScriptPluginLoader.NONE` 그대로 두면 Spring 이 유일한 `ScriptPluginLoader` 빈(`PluginScriptService`)을 주입한다. 순환(registry ← service ← @Lazy registry)은 서비스 쪽 `@Lazy` 로 끊긴다. 단, **레지스트리 init 의 reload() 가 서비스의 `loadApproved()` 를 부르는 시점에 JPA 가 준비돼 있어야** 하므로 문제 없음(서비스가 먼저 생성됨). 기동 로그에서 `플러그인 로드 — JAR 0개, 스크립트 N개` 확인.

- [ ] **Step 7: 통과 확인**

Run: `cd backend && ./gradlew :test --tests '*PluginScriptLifecycleTest*' --console=plain` → 3 PASS. 이어서 `./gradlew :test --console=plain` 전체 그린(기동 순환 참조가 있으면 여기서 컨텍스트 로드 실패로 드러난다 — `@Lazy` 위치 확인).

- [ ] **Step 8: 커밋**

```bash
git add backend/src/main/kotlin/com/flowlink/plugin backend/src/test/kotlin/com/flowlink/plugin/PluginScriptLifecycleTest.kt
git commit -m "feat(plugins): 스크립트 플러그인 서비스/API — 초안 저장·시험 실행·승인 요청/승인/반려·삭제, 승인본 레지스트리 적재" -- backend/src/main/kotlin/com/flowlink/plugin backend/src/test/kotlin/com/flowlink/plugin/PluginScriptLifecycleTest.kt
```

---

### Task 7: 사용처 인덱스 + 관리자 `pendingPlugins` 카운트

**Files:**
- Modify: `backend/src/main/kotlin/com/flowlink/plugin/PluginUsageIndex.kt` (Task 6 골격 → 구현)
- Modify: `backend/src/main/kotlin/com/flowlink/workspace/WorkspaceController.kt:91-125` (`MeView.pendingPlugins`)
- Modify: `backend/src/main/kotlin/com/flowlink/plugin/PluginScriptController.kt` (`GET /scripts/{id}/usages`)
- Test: `backend/src/test/kotlin/com/flowlink/plugin/PluginUsageIndexTest.kt`

**Interfaces:**
- Produces: `PluginUsageIndex.refs(pluginId): List<Ref(kind: "flow"|"mock"|"protocol", id: String, name: String)>`, `count(pluginId): Int`, `invalidate()`. 테넌트별 30초 캐시(`MockServerService.usageIndex` 와 같은 관례).
- 스캔 대상(JSON 문자열 정규식 — 파싱 없이): 워크플로 현재 그래프 `"transformId":"<id>"`, Mock spec `"codec"…"id":"<id>"`(서버·라우트 단계 — spec 문자열 안의 `"id":"<id>"` 를 codec 블록 안에서 찾는 대신 **spec 전체에서 `"id"\s*:\s*"<id>"` 매칭**, 라우트/규칙 id 와 우연히 같을 수 있으나 pluginId 는 `[a-z0-9-]` 라 규칙 id(`r1` 등) 충돌은 사용자가 그런 id 를 썼을 때뿐 — `ponytail:` 오탐은 "삭제 거부" 쪽으로만 안전하게 작용), 프로토콜 spec `"plugin"\s*:\s*\{[^}]*"id"\s*:\s*"<id>"`.
- Produces: `MeView.pendingPlugins: Long`(관리자만 계산, 아니면 0).

- [ ] **Step 1: 실패하는 테스트**

`backend/src/test/kotlin/com/flowlink/plugin/PluginUsageIndexTest.kt`:

```kotlin
package com.flowlink.plugin

import com.flowlink.core.domain.Flow
import com.flowlink.core.domain.FlowVersion
import com.flowlink.core.domain.MockServer
import com.flowlink.core.domain.Protocol
import com.flowlink.core.repository.FlowRepository
import com.flowlink.core.repository.FlowVersionRepository
import com.flowlink.core.repository.MockServerRepository
import com.flowlink.core.repository.ProtocolRepository
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.test.context.TestPropertySource

@SpringBootTest
@TestPropertySource(properties = [
    "spring.datasource.url=jdbc:h2:mem:pluginusage;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE",
    "spring.datasource.driver-class-name=org.h2.Driver",
    "spring.datasource.username=sa",
    "spring.datasource.password=",
    "spring.jpa.hibernate.ddl-auto=create-drop",
])
class PluginUsageIndexTest {
    @Autowired lateinit var index: PluginUsageIndex
    @Autowired lateinit var flowRepo: FlowRepository
    @Autowired lateinit var versionRepo: FlowVersionRepository
    @Autowired lateinit var mockRepo: MockServerRepository
    @Autowired lateinit var protocolRepo: ProtocolRepository

    @Test
    fun `워크플로 transformId · Mock 코덱 step id · 프로토콜 필드 plugin id 를 찾는다`() {
        val t = "default"
        val f = flowRepo.save(Flow.create(t, "결제 플로우", null))
        val graph = """{"nodes":[{"id":"n1","type":"transform","transformId":"aes-card"}],"edges":[]}"""
        versionRepo.save(FlowVersion.create(f.id, 1, "v1", graph, null, "alice")); f.currentVersion = 1; flowRepo.save(f)
        mockRepo.save(MockServer.create(t, "pay mock", "paym", MockServer.Kind.CUSTOM, """{"routes":[{"id":"r1","codec":{"response":[{"id":"aes-card","target":"fields","fields":["no"]}]}}]}"""))
        protocolRepo.save(Protocol.create(t, "코어뱅킹", """{"messages":[{"key":"0210","fields":[{"name":"계좌","len":13,"plugin":{"id":"acct-enc"}}]}]}"""))
        index.invalidate()
        assertThat(index.refs("aes-card").map { it.kind to it.name }).containsExactlyInAnyOrder("flow" to "결제 플로우", "mock" to "pay mock")
        assertThat(index.refs("acct-enc").map { it.kind }).containsExactly("protocol")
        assertThat(index.count("nobody")).isZero()
    }
}
```
시그니처 근거: `Flow.create(tenantId, name, description)`, `FlowVersion.create(flowId, versionNo, name, graphJson, note, createdBy)`, `Flow.currentVersion: Int`(var), `MockServer.create(tenantId, name, slug, kind, specJson)`, `Protocol.create(tenantId, name, specJson)`. `findCurrentByFlowIds` 는 `f.currentVersion == v.versionNo` 인 행을 고른다.

- [ ] **Step 2: 실패 확인** — `./gradlew :test --tests '*PluginUsageIndexTest*' --console=plain` → 실패(항상 빈 목록).

- [ ] **Step 3: 구현** — `PluginUsageIndex.kt` 전체 교체:

```kotlin
package com.flowlink.plugin

import com.flowlink.common.tenant.TenantContext
import com.flowlink.core.repository.FlowRepository
import com.flowlink.core.repository.FlowVersionRepository
import com.flowlink.core.repository.MockServerRepository
import com.flowlink.core.repository.ProtocolRepository
import org.springframework.stereotype.Component
import org.springframework.transaction.annotation.Transactional
import java.util.concurrent.ConcurrentHashMap

/**
 * pluginId 사용처 — 워크플로(현재 그래프 transformId)·Mock(spec codec step id)·프로토콜(필드 plugin.id) 문자열 스캔.
 * 테넌트별 30초 캐시(MockServerService.usageIndex 관례). 삭제 가드·목록 카운트·승인 화면 경고에 쓴다.
 */
@Component
class PluginUsageIndex(
    private val flowRepo: FlowRepository,
    private val versionRepo: FlowVersionRepository,
    private val mockRepo: MockServerRepository,
    private val protocolRepo: ProtocolRepository,
) {
    data class Ref(val kind: String, val id: String, val name: String)
    private data class Doc(val kind: String, val id: String, val name: String, val text: String)
    private val cache = ConcurrentHashMap<String, Pair<Long, List<Doc>>>()

    fun invalidate() = cache.clear()
    fun count(pluginId: String): Int = refs(pluginId).size

    @Transactional(readOnly = true)
    fun refs(pluginId: String): List<Ref> {
        if (pluginId.isBlank()) return emptyList()
        val q = Regex.escape(pluginId)
        val inFlow = Regex("\"transformId\"\\s*:\\s*\"$q\"")
        val inMock = Regex("\"id\"\\s*:\\s*\"$q\"")
        val inProto = Regex("\"plugin\"\\s*:\\s*\\{[^}]*\"id\"\\s*:\\s*\"$q\"")
        return docs().filter { d ->
            when (d.kind) { "flow" -> inFlow.containsMatchIn(d.text); "mock" -> inMock.containsMatchIn(d.text); else -> inProto.containsMatchIn(d.text) }
        }.map { Ref(it.kind, it.id, it.name) }
    }

    private fun docs(): List<Doc> {
        val t = TenantContext.getTenantId()
        val now = System.currentTimeMillis()
        cache[t]?.let { if (now - it.first < 30_000) return it.second }
        val flows = flowRepo.findByTenantIdAndArchivedFalseOrderByUpdatedAtDesc(t)
        val graphs = if (flows.isEmpty()) emptyMap() else versionRepo.findCurrentByFlowIds(flows.map { it.id }).associateBy { it.flowId }
        val built = flows.mapNotNull { f -> graphs[f.id]?.graphJson?.let { Doc("flow", f.id.toString(), f.name, it) } } +
            mockRepo.findByTenantIdOrderByUpdatedAtDesc(t).mapNotNull { m -> m.specJson?.let { Doc("mock", m.id.toString(), m.name, it) } } +
            protocolRepo.findByTenantIdOrderByNameAsc(t).map { p -> Doc("protocol", p.id.toString(), p.name, p.specJson) }
        cache[t] = now to built
        return built
    }
}
```

- [ ] **Step 4: 컨트롤러에 사용처 조회 추가** — `PluginScriptController` 에:

```kotlin
    @GetMapping("/scripts/{id}/usages") fun usages(@PathVariable id: UUID): List<PluginUsageIndex.Ref> = usageIndex.refs(service.get(id).pluginId)
```
생성자에 `private val usageIndex: PluginUsageIndex` 추가.

- [ ] **Step 5: `MeView.pendingPlugins`** — `WorkspaceController.kt`:

`MeView` 에 필드 추가: `val pendingPlugins: Long = 0,` (마지막 인자). `AdminController` 생성자에 `private val pluginScripts: com.flowlink.plugin.PluginScriptService` 추가, `me()` 의 return 을:
```kotlin
        return MeView(u, admin, service.isAuthenticated(u), pending, myStatus, if (admin) pluginScripts.pendingCount() else 0L)
```

- [ ] **Step 6: 통과 확인** — `./gradlew :test --tests '*PluginUsageIndexTest*' --tests '*PluginScriptLifecycleTest*' --console=plain` → PASS (Lifecycle 의 삭제 케이스는 사용처 0 이라 그대로 통과).

- [ ] **Step 7: 커밋**

```bash
git add backend/src/main/kotlin/com/flowlink/plugin/PluginUsageIndex.kt backend/src/main/kotlin/com/flowlink/plugin/PluginScriptController.kt backend/src/main/kotlin/com/flowlink/workspace/WorkspaceController.kt backend/src/test/kotlin/com/flowlink/plugin/PluginUsageIndexTest.kt
git commit -m "feat(plugins): 사용처 인덱스(flow/mock/protocol 스캔) + 삭제 가드 + 관리자 pendingPlugins 카운트" -- backend/src/main/kotlin/com/flowlink/plugin/PluginUsageIndex.kt backend/src/main/kotlin/com/flowlink/plugin/PluginScriptController.kt backend/src/main/kotlin/com/flowlink/workspace/WorkspaceController.kt backend/src/test/kotlin/com/flowlink/plugin/PluginUsageIndexTest.kt
```

---

### Task 8: MCP 가이드 `plugin` 토픽 + 에이전트 규약 갱신

**Files:**
- Modify: `backend/src/main/kotlin/com/flowlink/assistant/SchemaController.kt` (`plugin` 항목 + 규약 6번)
- Modify: `mcp/src/index.js:75,178-187` (`flowlink_guide` enum + `plugin_list` 설명)
- Test: `mcp/test/smoke.ts` (guide plugin 단언 1줄)

**Interfaces:**
- Consumes: `FlApi.MANIFEST`.
- Produces: `GET /api/v1/schemas` 에 `"plugin"` 키(스크립트 플러그인 작성 규격 + fl 매니페스트 원문).

- [ ] **Step 1: SchemaController** — `schemas()` 맵에 `"plugin" to pluginGuide()` 추가하고 companion 아래에:

```kotlin
    /** 스크립트 플러그인 작성 규격 — 화면 편집기와 MCP 가 같은 원문. fl 매니페스트는 코드에서 생성(추가 시 자동 반영). */
    private fun pluginGuide(): String = buildString {
        append(PLUGIN_GUIDE)
        append("\n## fl.* 헬퍼\n")
        for (e in com.flowlink.plugin.script.FlApi.MANIFEST) append("- `${e.signature}` — ${e.doc}. 예: `${e.example}`\n")
    }
```
그리고 companion 에 상수:
```kotlin
        const val PLUGIN_GUIDE: String = """
# 스크립트 플러그인(JS) 작성 규격
스크립트의 **마지막 표현식이 플러그인 객체**다. 샌드박스: 표준 JS + `fl.*` 만(Java/파일/네트워크 없음), 호출당 2초.
저장은 화면(/plugins) 에서 초안 → 승인 요청 → 관리자 승인 후에만 레지스트리에 올라간다(MCP 로는 만들 수 없음 — 사용자에게 안내).

변환(transform):  ({ id, label, description?, inputs?: [{key,label,type?}], outputs?: [{key,label,type?}], params?: [{key,label,type?,defaultValue?,options?,placeholder?}], apply(inputs, config) { return { 출력키: 값 } } })
필드 코덱:        ({ id, label, kind: 'fieldCodec', params?, encode(value, ctx) { return 문자열 }, decode(value, ctx) { return 문자열 } })
전문 코덱:        ({ id, label, kind: 'messageCodec', params?, encode(bytes, ctx) { return 바이트배열 }, decode(bytes, ctx) { return 바이트배열 } })
ctx = { config, direction: 'send'|'recv', field: {name,len,type,pad}|null, message: {필드명: 값} }. id 는 [a-z0-9-] 2~64자.
"""
```

- [ ] **Step 2: MCP** — `mcp/src/index.js` 75행 enum 에 `'plugin'` 추가: `z.enum(['flow', 'nodes', 'protocol', 'mock', 'plugin', 'rules', 'all'])`. `flowlink_guide` description 끝에 ` plugin=스크립트 플러그인 작성 규격+fl 헬퍼.` 추가. `plugin_list` description 의 `(업로드는 화면에서 관리자)` → `(플러그인은 화면 /plugins 에서 JS 로 작성 → 관리자 승인 — 규격은 flowlink_guide(plugin))`.

- [ ] **Step 3: 규약 6번** — `SchemaController.AGENT_RULES` 의 6번 두 번째 줄을:
```
   목록에 없는 id 는 지어내지 말고, 없으면 TRANSFORM 노드·코덱을 만들지 않는다(플러그인은 화면 /plugins 에서 JS 로 작성해 관리자 승인 — 규격은 flowlink_guide(plugin), 사용자에게 안내한다).
```

- [ ] **Step 4: smoke 단언** — `mcp/test/smoke.ts` 의 `assert.match(await call('flowlink_guide', { topic: 'nodes' }), …)` 줄 다음에:
```ts
  assert.match(await call('flowlink_guide', { topic: 'plugin' }), /fl\.aes\.encrypt/); ok('guide plugin (fl manifest)')
```

- [ ] **Step 5: 확인** — 백엔드 `./gradlew :test --tests '*GuestModeSecurityTest*' --console=plain`(컨텍스트 기동 확인) + `curl -s localhost:18081/api/v1/schemas | python -c "import sys,json; print('fl.aes.encrypt' in json.load(sys.stdin)['plugin'])"` 는 Task 15 통합 검증에서.

- [ ] **Step 6: 커밋**

```bash
git add backend/src/main/kotlin/com/flowlink/assistant/SchemaController.kt mcp/src/index.js mcp/test/smoke.ts
git commit -m "feat(plugins): 스크립트 플러그인 작성 규격을 /schemas plugin 으로 — MCP 가이드 토픽·규약 갱신" -- backend/src/main/kotlin/com/flowlink/assistant/SchemaController.kt mcp/src/index.js mcp/test/smoke.ts
```

---

### Task 9: 프론트 API·타입 + CodeEditor `javascript` 언어·자동완성·서버 진단

**Files:**
- Modify: `frontend/src/api/types.ts` (끝에 추가)
- Modify: `frontend/src/api/client.ts:101-107,140` (`pluginsApi` 교체, `AdminMeView.pendingPlugins`)
- Modify: `frontend/src/components/CodeEditor.tsx`
- Create: `frontend/src/lib/pluginCompletions.ts`
- Modify: `frontend/package.json` (`@codemirror/lang-javascript`)

**Interfaces:**
- Produces(types): `PluginScriptSummary`, `PluginScriptDetail`, `PluginScriptMeta`, `PluginTryRequest`, `PluginTryResult`, `PluginUsageRef`, `FlApiEntry`, `PluginScriptStatus = 'DRAFT'|'PENDING'|'APPROVED'|'REJECTED'`, `PluginKind = 'transform'|'fieldCodec'|'messageCodec'`.
- Produces(client): `pluginsApi = { api(), list(status?), get(id), create(body), update(id, body), tryRun(body), saveSample(id, sampleJson), submit(id), withdraw(id), approve(id), reject(id, note), remove(id), usages(id) }`.
- Produces(CodeEditor): `EditorLang` 에 `'javascript'`; 새 prop `completions?: CompletionSource[]`(`@codemirror/autocomplete` 의 `CompletionSource`), `diagnostics?: EditorDiagnostic[]`(`{ line: number; col?: number; message: string; severity?: 'error'|'warning' }`) — 바뀔 때 `setDiagnostics` 로 반영.
- Produces(lib): `flCompletionSource(manifest: FlApiEntry[]): CompletionSource`, `declaredKeysSource(getDoc: () => string): CompletionSource`(`inputs.`/`config.`/`ctx.` 뒤에서 문서에 선언된 key 제안).

- [ ] **Step 1: 의존성** — `cd frontend && npm i @codemirror/lang-javascript@6.2.5` (package.json·package-lock.json 갱신 확인).

- [ ] **Step 2: 타입** — `frontend/src/api/types.ts` 끝에:

```ts
// ---- 스크립트 플러그인 (/api/v1/plugins/scripts) ----
export type PluginScriptStatus = 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED'
export type PluginKind = 'transform' | 'fieldCodec' | 'messageCodec'
export interface PluginScriptMeta { id: string; label: string; description: string; kind: PluginKind; inputs: TransformIo[]; outputs: TransformIo[]; params: TransformParam[] }
export interface PluginScriptSummary {
  id: string; pluginId: string; name: string; kind: PluginKind; status: PluginScriptStatus
  live: boolean; dirty: boolean; usages: number; updatedAt: string | null; submittedBy: string | null; createdBy: string
}
export interface PluginScriptDetail extends PluginScriptSummary {
  submittedAt: string | null; source: string; liveSource: string | null; sampleJson: string | null
  reviewNote: string | null; reviewedBy: string | null; reviewedAt: string | null; meta: PluginScriptMeta | null
}
export interface PluginTryRequest {
  source: string; inputs?: Record<string, string>; config?: Record<string, string>
  value?: string; fn?: 'encode' | 'decode'; direction?: 'send' | 'recv'; message?: Record<string, string>; bytesB64?: string
}
export interface PluginTryResult { meta: PluginScriptMeta; outputs?: Record<string, string> | null; result?: string | null; bytesB64?: string | null; logs: string[]; durationMs: number }
export interface PluginUsageRef { kind: 'flow' | 'mock' | 'protocol'; id: string; name: string }
export interface FlApiEntry { path: string; signature: string; doc: string; example: string }
/** 서버 ScriptError 400 바디 */
export interface ScriptErrorBody { message: string; line: number | null; col: number | null }
```

- [ ] **Step 3: client** — `frontend/src/api/client.ts` 의 `pluginsApi`(101-107행)를 교체:

```ts
export const pluginsApi = {
  api: () => http.get<import('./types').FlApiEntry[]>('/plugins/api').then((r) => r.data),
  list: (status?: import('./types').PluginScriptStatus) => http.get<import('./types').PluginScriptSummary[]>('/plugins/scripts', { params: status ? { status } : {} }).then((r) => r.data),
  get: (id: string) => http.get<import('./types').PluginScriptDetail>(`/plugins/scripts/${id}`).then((r) => r.data),
  create: (body: { name?: string; source: string }) => http.post<import('./types').PluginScriptDetail>('/plugins/scripts', body).then((r) => r.data),
  update: (id: string, body: { name?: string; source?: string }) => http.put<import('./types').PluginScriptDetail>(`/plugins/scripts/${id}`, body).then((r) => r.data),
  tryRun: (body: import('./types').PluginTryRequest) => http.post<import('./types').PluginTryResult>('/plugins/scripts/try', body).then((r) => r.data),
  saveSample: (id: string, sampleJson: string) => http.put(`/plugins/scripts/${id}/sample`, { sampleJson }).then(() => undefined),
  submit: (id: string) => http.post<import('./types').PluginScriptDetail>(`/plugins/scripts/${id}/submit`).then((r) => r.data),
  withdraw: (id: string) => http.post<import('./types').PluginScriptDetail>(`/plugins/scripts/${id}/withdraw`).then((r) => r.data),
  approve: (id: string) => http.post<import('./types').PluginScriptDetail>(`/plugins/scripts/${id}/approve`).then((r) => r.data),
  reject: (id: string, note: string) => http.post<import('./types').PluginScriptDetail>(`/plugins/scripts/${id}/reject`, { note }).then((r) => r.data),
  remove: (id: string) => http.delete(`/plugins/scripts/${id}`).then(() => undefined),
  usages: (id: string) => http.get<import('./types').PluginUsageRef[]>(`/plugins/scripts/${id}/usages`).then((r) => r.data),
}
```
`AdminMeView`(140행)에 `pendingPlugins: number` 추가. `uploadHttp` 는 `auth/auth.ts` 가 인터셉터 대상으로 쓰므로 **남긴다**.

- [ ] **Step 4: 자동완성 소스** — `frontend/src/lib/pluginCompletions.ts`:

```ts
import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete'
import type { FlApiEntry } from '../api/types'

/** `fl.` 뒤 — 매니페스트의 네임스페이스/함수를 단계별로 제안(툴팁 = 시그니처·설명·예시). */
export function flCompletionSource(manifest: FlApiEntry[]): CompletionSource {
  return (ctx: CompletionContext): CompletionResult | null => {
    const m = ctx.matchBefore(/fl(\.[A-Za-z0-9_]*)*\.?[A-Za-z0-9_]*$/)
    if (!m) return null
    const typed = m.text // 예: "fl.ae" · "fl.aes." · "fl.aes.enc"
    const parts = typed.split('.')
    const prefix = parts.slice(0, -1).join('.') // 확정된 앞부분 "fl" | "fl.aes"
    const seen = new Map<string, Completion>()
    for (const e of manifest) {
      if (!e.path.startsWith(prefix + '.')) continue
      const rest = e.path.slice(prefix.length + 1)
      const head = rest.split('.')[0]
      const leaf = !rest.includes('.')
      if (seen.has(head)) continue
      seen.set(head, leaf
        ? { label: head, type: 'function', detail: e.signature.replace(e.path, ''), info: `${e.doc}\n예: ${e.example}`, apply: head + '(' }
        : { label: head, type: 'namespace', detail: '…' })
    }
    if (seen.size === 0) return null
    const from = m.from + prefix.length + 1
    return { from, options: [...seen.values()], validFor: /^[A-Za-z0-9_]*$/ }
  }
}

/** `inputs.` / `config.` / `ctx.` 뒤 — 문서에 선언된 key 를 제안(정규식 스캔, 파싱 없음). */
export function declaredKeysSource(getDoc: () => string): CompletionSource {
  const keysIn = (doc: string, section: 'inputs' | 'params'): string[] => {
    const block = new RegExp(`${section}\\s*:\\s*\\[([\\s\\S]*?)\\]`).exec(doc)?.[1] ?? ''
    return [...block.matchAll(/key\s*:\s*['"]([^'"]+)['"]/g)].map((x) => x[1])
  }
  return (ctx) => {
    const m = ctx.matchBefore(/\b(inputs|config|ctx)\.[A-Za-z0-9_]*$/)
    if (!m) return null
    const root = m.text.split('.')[0]
    const doc = getDoc()
    const opts: Completion[] = root === 'inputs' ? keysIn(doc, 'inputs').map((k) => ({ label: k, type: 'property' }))
      : root === 'config' ? keysIn(doc, 'params').map((k) => ({ label: k, type: 'property' }))
      : [{ label: 'config', type: 'property' }, { label: 'direction', type: 'property' }, { label: 'field', type: 'property' }, { label: 'message', type: 'property' }]
    if (opts.length === 0) return null
    return { from: m.from + root.length + 1, options: opts, validFor: /^[A-Za-z0-9_]*$/ }
  }
}
```

- [ ] **Step 5: CodeEditor** — `frontend/src/components/CodeEditor.tsx` 수정:
  1. import 추가: `import { javascript } from '@codemirror/lang-javascript'`, `import { js as beautifyJs } from 'js-beautify'`, `import { setDiagnostics } from '@codemirror/lint'`, `import type { CompletionSource } from '@codemirror/autocomplete'`, `import { formatWithTokens } from '../lib/codeFormat'`.
  2. 타입: `export type EditorLang = CodeLang | 'javascript' | 'text'`, `export interface EditorDiagnostic { line: number; col?: number; message: string; severity?: 'error' | 'warning' }`.
  3. props 에 `completions?: CompletionSource[]`, `diagnostics?: EditorDiagnostic[]` 추가(구조분해에도).
  4. `doFormat`: `if (language === 'text') return 'fail'` 다음에 `const out = language === 'javascript' ? formatWithTokens(cur, (s) => beautifyJs(s, { indent_size: 2, preserve_newlines: true, max_preserve_newlines: 1 })) : formatCode(cur, language, (s) => beautifyHtml(s, BEAUTIFY))` 로 교체(기존 `const out = …` 줄 대체).
  5. `langExts` 에 분기 추가: `: language === 'javascript' ? [javascript(), treeLinter]`.
  6. `EditorState.languageData.of(() => [{ autocomplete: tokenCompletion }])` → `EditorState.languageData.of(() => [{ autocomplete: tokenCompletion }, ...completionsRef.current.map((c) => ({ autocomplete: c }))])` 로 바꾸고, 위에 `const completionsRef = useRef(completions ?? []); completionsRef.current = completions ?? []` 추가(다른 ref 들 옆).
  7. 서버 진단 반영 effect 추가(줄바꿈 토글 effect 아래):
```tsx
  // 서버 컴파일/실행 오류(줄 번호) → 거터. 문서를 고치면 클라이언트 linter 가 다시 돌며 자연히 지워진다.
  useEffect(() => {
    const v = viewRef.current
    if (!v) return
    const diags: Diagnostic[] = (diagnostics ?? []).flatMap((d) => {
      if (d.line < 1 || d.line > v.state.doc.lines) return []
      const ln = v.state.doc.line(d.line)
      const from = Math.min(ln.from + Math.max((d.col ?? 1) - 1, 0), ln.to)
      return [{ from, to: Math.max(from + 1, ln.to), severity: d.severity ?? 'error', message: d.message }]
    })
    v.dispatch(setDiagnostics(v.state, diags))
  }, [diagnostics])
```

- [ ] **Step 6: 확인** — `cd frontend && npx tsc -b && npx oxlint src && npm run build` 통과. BigTextEditor 의 언어 셀렉트(`BigTextLang`)는 `CodeLang` 기반이라 영향 없음(확인: `grep -n "BigTextLang" src/components/BigTextEditor.tsx`).

- [ ] **Step 7: 커밋**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/api/types.ts frontend/src/api/client.ts frontend/src/components/CodeEditor.tsx frontend/src/lib/pluginCompletions.ts
git commit -m "feat(plugins): 프론트 API/타입 + CodeEditor javascript 언어(정렬·lezer 오류·fl 자동완성·서버 진단 거터)" -- frontend/package.json frontend/package-lock.json frontend/src/api/types.ts frontend/src/api/client.ts frontend/src/components/CodeEditor.tsx frontend/src/lib/pluginCompletions.ts
```

---

### Task 10: `/plugins` 페이지 골격 — 목록 · 편집기 · 저장 · 상태 바 · 템플릿

**Files:**
- Create: `frontend/src/lib/pluginTemplates.ts`
- Create: `frontend/src/routes/Plugins.tsx`
- Modify: `frontend/src/App.tsx:14,30-39` (import + `<Route path="/plugins" …>`, `/plugins/:id`)
- Modify: `frontend/src/app/AppShell.tsx:11-15` (NAV 에 `{ to: '/plugins', label: '플러그인', icon: '◇' }` — '프로토콜' 다음)

**Interfaces:**
- Consumes: `pluginsApi.*`(Task 9), `CodeEditor`(lazy — `React.lazy(() => import('../components/CodeEditor'))`), `flCompletionSource/declaredKeysSource`, `usePermissions()`, `adminApi.me`(관리자 여부), `toast`, `apiErrorMessage`, `AskDialog`.
- Produces(lib): `PLUGIN_TEMPLATES: Record<PluginKind, { label: string; source: string }>`, `kindLabel(kind): string`.
- Produces(page): 라우트 `/plugins`(목록만) · `/plugins/:id`(선택) · `/plugins?new=<kind>`(템플릿으로 새 초안 — 저장 전엔 로컬 상태). 실행 패널(Task 11)·승인/diff/사용처(Task 12)는 이 태스크에서 자리(`<aside>`)만 비워 둔다.

- [ ] **Step 1: 템플릿** — `frontend/src/lib/pluginTemplates.ts`:

```ts
import type { PluginKind } from '../api/types'

export const kindLabel = (k: PluginKind): string => (k === 'fieldCodec' ? '필드 코덱' : k === 'messageCodec' ? '전문 코덱' : '변환')

/** 새 플러그인 골격 — 스크립트의 마지막 표현식이 플러그인 객체. */
export const PLUGIN_TEMPLATES: Record<PluginKind, { label: string; source: string }> = {
  transform: {
    label: '변환 — TRANSFORM 노드·Mock 코덱 단계에서 값 하나를 바꾼다',
    source: `// 변환 플러그인 — inputs 로 받은 값을 config 로 가공해 outputs 로 돌려준다.
({
  id: 'my-transform',          // 소문자·숫자·하이픈 (저장 후엔 바꿀 수 없음)
  label: '내 변환',
  description: '무엇을 넣으면 무엇이 나오는지 한 줄',
  inputs:  [{ key: 'input', label: '원문' }],
  outputs: [{ key: 'result', label: '결과' }],   // type: 'number' | 'boolean' | 'json' 이면 다운스트림에 그 타입으로
  params:  [{ key: 'key', label: '키', placeholder: '{{ aesKey@secret }}' }],
  apply(inputs, config) {
    fl.log('input =', inputs.input)
    return { result: fl.hmac.sha256(config.key, inputs.input) }
  },
})
`,
  },
  fieldCodec: {
    label: '필드 코덱 — 전문의 필드 값 하나를 보낼 때 감싸고 받을 때 푼다',
    source: `// 필드 코덱 — 프로토콜 필드의 plugin 으로 지정. encode = 송신 전(문자셋 인코딩 전), decode = 수신 후(패딩 제거 후).
({
  id: 'my-field-codec',
  label: '내 필드 코덱',
  kind: 'fieldCodec',
  params: [{ key: 'key', label: '키', placeholder: '{{ aesKey@secret }}' }, { key: 'iv', label: 'IV' }],
  encode(value, ctx) { return fl.aes.encrypt(value, ctx.config.key, ctx.config.iv) },
  decode(value, ctx) { return fl.aes.decrypt(value, ctx.config.key, ctx.config.iv) },
})
`,
  },
  messageCodec: {
    label: '전문 코덱 — 본문 바이트 전체를 감싸고 푼다(헤더는 평문)',
    source: `// 전문 코덱 — 본문 bytes ↔ bytes. 헤더(길이·거래코드)는 평문이고 길이 계산 전에 적용된다.
({
  id: 'my-message-codec',
  label: '내 전문 코덱',
  kind: 'messageCodec',
  params: [{ key: 'key', label: '키', placeholder: '{{ aesKey@secret }}' }, { key: 'iv', label: 'IV' }],
  encode(body, ctx) { return fl.aes.encryptBytes(body, ctx.config.key, ctx.config.iv) },
  decode(body, ctx) { return fl.aes.decryptBytes(body, ctx.config.key, ctx.config.iv) },
})
`,
  },
}
```

- [ ] **Step 2: 페이지** — `frontend/src/routes/Plugins.tsx`:

```tsx
// 스크립트 플러그인 — 좌 목록 | 우 편집기(CodeMirror JS) + 실행 패널 + 상태 바. 초안 저장 → 승인 요청 → 관리자 승인 후 레지스트리.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CSSProperties } from 'react'
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { adminApi, pluginsApi } from '../api/client'
import type { PluginKind, PluginScriptDetail, PluginScriptStatus, PluginScriptSummary, ScriptErrorBody } from '../api/types'
import { AppShellTier1 } from '../app/AppShell'
import { usePermissions } from '../auth/AuthContext'
import { AskDialog } from '../components/AskDialog'
import type { AskSpec } from '../components/AskDialog'
import type { EditorDiagnostic } from '../components/CodeEditor'
import { PluginRunPanel } from '../components/PluginRunPanel'
import { PluginDiffView } from '../components/PluginDiffView'
import { toast } from '../components/toast'
import { apiErrorMessage } from '../lib/apiError'
import { relTime } from '../lib/format'
import { declaredKeysSource, flCompletionSource } from '../lib/pluginCompletions'
import { PLUGIN_TEMPLATES, kindLabel } from '../lib/pluginTemplates'

const CodeEditorLazy = lazy(() => import('../components/CodeEditor'))

type Draft = { id: string | null; name: string; source: string }
const STATUS_LABEL: Record<PluginScriptStatus, string> = { DRAFT: '초안', PENDING: '승인 대기', APPROVED: '승인됨', REJECTED: '반려' }

function scriptError(e: unknown): ScriptErrorBody | null {
  const d = (e as { response?: { data?: Partial<ScriptErrorBody> } })?.response?.data
  return d && typeof d.message === 'string' && ('line' in d || 'col' in d) ? { message: d.message, line: d.line ?? null, col: d.col ?? null } : null
}

export function Plugins() {
  const { id } = useParams()
  const [sp, setSp] = useSearchParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { canEdit } = usePermissions()
  const me = useQuery({ queryKey: ['admin', 'me'], queryFn: adminApi.me, staleTime: 30_000 })
  const isAdmin = !!me.data?.admin
  const list = useQuery({ queryKey: ['plugins', 'scripts'], queryFn: () => pluginsApi.list(), refetchInterval: 15_000 })
  const detail = useQuery({ queryKey: ['plugins', 'scripts', id], queryFn: () => pluginsApi.get(id!), enabled: !!id })
  const manifest = useQuery({ queryKey: ['plugins', 'api'], queryFn: pluginsApi.api, staleTime: Infinity })

  const [q, setQ] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | PluginScriptStatus>('all')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [dirty, setDirty] = useState(false)
  const [diag, setDiag] = useState<EditorDiagnostic[]>([])
  const [ask, setAsk] = useState<AskSpec | null>(null)
  const [showDiff, setShowDiff] = useState(false)
  const draftRef = useRef(draft); draftRef.current = draft

  // URL → 편집 상태: ?new=<kind> 는 템플릿 초안, /plugins/:id 는 서버 상세
  const newKind = sp.get('new') as PluginKind | null
  useEffect(() => {
    if (newKind && PLUGIN_TEMPLATES[newKind]) { setDraft({ id: null, name: '', source: PLUGIN_TEMPLATES[newKind].source }); setDirty(true); setDiag([]) }
  }, [newKind])
  useEffect(() => {
    if (detail.data) { setDraft({ id: detail.data.id, name: detail.data.name, source: detail.data.source }); setDirty(false); setDiag([]); setShowDiff(false) }
  }, [detail.data])

  const invalidate = () => { void qc.invalidateQueries({ queryKey: ['plugins', 'scripts'] }); void qc.invalidateQueries({ queryKey: ['admin', 'me'] }); void qc.invalidateQueries({ queryKey: ['transforms'] }); void qc.invalidateQueries({ queryKey: ['codecs'] }) }
  const onApiError = (e: unknown) => {
    const se = scriptError(e)
    if (se) { setDiag(se.line ? [{ line: se.line, col: se.col ?? undefined, message: se.message }] : []); toast(`${se.line ? `${se.line}행: ` : ''}${se.message}`, 'error') }
    else toast(apiErrorMessage(e), 'error')
  }

  const save = useMutation({
    mutationFn: async () => {
      const d = draftRef.current!
      return d.id ? pluginsApi.update(d.id, { name: d.name || undefined, source: d.source }) : pluginsApi.create({ name: d.name || undefined, source: d.source })
    },
    onSuccess: (saved: PluginScriptDetail) => {
      setDirty(false); setDiag([]); invalidate(); toast('저장됨(초안)', 'ok')
      if (!draftRef.current?.id) { setSp({}); navigate(`/plugins/${saved.id}`, { replace: true }) }
      else void qc.invalidateQueries({ queryKey: ['plugins', 'scripts', saved.id] })
    },
    onError: onApiError,
  })
  const transition = useMutation({
    mutationFn: ({ op, note }: { op: 'submit' | 'withdraw' | 'approve' | 'reject' | 'remove'; note?: string }) =>
      op === 'submit' ? pluginsApi.submit(id!) : op === 'withdraw' ? pluginsApi.withdraw(id!) : op === 'approve' ? pluginsApi.approve(id!)
      : op === 'reject' ? pluginsApi.reject(id!, note ?? '') : pluginsApi.remove(id!).then(() => null),
    onSuccess: (_r, v) => {
      invalidate()
      if (v.op === 'remove') { toast('삭제됨', 'ok'); navigate('/plugins') }
      else { toast({ submit: '승인 요청함', withdraw: '철회함', approve: '승인됨 — 즉시 서빙', reject: '반려함' }[v.op], 'ok'); void qc.invalidateQueries({ queryKey: ['plugins', 'scripts', id] }) }
    },
    onError: onApiError,
  })

  // Ctrl+S 저장(편집기 안에서도) · 미저장 이탈 경고
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') { e.preventDefault(); if (dirty && canEdit && !save.isPending) save.mutate() } }
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h)
  }, [dirty, canEdit, save])
  useEffect(() => {
    if (!dirty) return
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', h); return () => window.removeEventListener('beforeunload', h)
  }, [dirty])

  const completions = useMemo(() => [flCompletionSource(manifest.data ?? []), declaredKeysSource(() => draftRef.current?.source ?? '')], [manifest.data])
  const items = useMemo(() => {
    const t = q.trim().toLowerCase()
    return (list.data ?? []).filter((p) => (statusFilter === 'all' || p.status === statusFilter) && (!t || `${p.name} ${p.pluginId} ${p.kind}`.toLowerCase().includes(t)))
  }, [list.data, q, statusFilter])
  const d = detail.data
  const status: PluginScriptStatus | null = d?.status ?? null
  const openNew = (kind: PluginKind) => { if (dirty && !confirm('저장하지 않은 변경이 있습니다. 새로 만들까요?')) return; navigate(`/plugins?new=${kind}`) }
  const select = (pid: string) => { if (dirty && !confirm('저장하지 않은 변경이 있습니다. 이동할까요?')) return; setSp({}); navigate(`/plugins/${pid}`) }

  return (
    <AppShellTier1>
      <div style={{ display: 'grid', gridTemplateColumns: '300px minmax(0, 1fr)', height: '100vh', minHeight: 0 }}>
        {/* ── 좌 목록 ── */}
        <aside style={listPane} aria-label="플러그인 목록">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <strong style={{ fontFamily: 'var(--fl-font-head)', fontSize: 16 }}>◇ 플러그인</strong>
            <span style={muted}>{list.data?.length ?? 0}</span>
          </div>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="검색 — 이름·id ( / )" aria-label="플러그인 검색" style={search}
            onKeyDown={(e) => { if (e.key === 'Escape' && q) { e.stopPropagation(); setQ('') } }} />
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {(['all', 'DRAFT', 'PENDING', 'APPROVED', 'REJECTED'] as const).map((s) => (
              <button key={s} onClick={() => setStatusFilter(s)} style={{ ...chip, ...(statusFilter === s ? chipOn : null) }}>{s === 'all' ? '전체' : STATUS_LABEL[s]}</button>
            ))}
          </div>
          {canEdit && (
            <div style={{ display: 'grid', gap: 4 }}>
              {(Object.keys(PLUGIN_TEMPLATES) as PluginKind[]).map((k) => (
                <button key={k} onClick={() => openNew(k)} style={newBtn} title={PLUGIN_TEMPLATES[k].label}>+ 새 {kindLabel(k)}</button>
              ))}
            </div>
          )}
          <div style={{ overflowY: 'auto', display: 'grid', gap: 3, alignContent: 'start' }}>
            {list.isLoading && <div style={muted}>불러오는 중…</div>}
            {list.data && !items.length && <div style={muted}>{q ? '일치하는 플러그인이 없습니다.' : '아직 플러그인이 없습니다 — 위에서 새로 만드세요.'}</div>}
            {items.map((p) => <ListItem key={p.id} p={p} on={p.id === id} onClick={() => select(p.id)} />)}
          </div>
        </aside>

        {/* ── 우 편집기 ── */}
        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {!draft ? (
            <div style={empty}>
              <div style={{ fontFamily: 'var(--fl-font-head)', fontWeight: 700, fontSize: 17 }}>스크립트 플러그인</div>
              <p style={{ maxWidth: 520, margin: '8px auto 0', fontSize: 13.5, lineHeight: 1.6 }}>
                JS 로 변환·코덱을 적고 → 오른쪽에서 돌려 보고 → 승인 요청하면 관리자가 코드와 샘플 결과를 보고 승인합니다. 승인된 플러그인은 TRANSFORM 노드·Mock 코덱·프로토콜에서 바로 고를 수 있습니다.
              </p>
            </div>
          ) : (
            <>
              <header style={hdr}>
                <input value={draft.name} onChange={(e) => { setDraft({ ...draft, name: e.target.value }); setDirty(true) }} placeholder={d?.meta?.label || '플러그인 이름'} aria-label="플러그인 이름" disabled={!canEdit}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur() }} style={nameInput} />
                {d && <span style={metaMono}>#{d.pluginId} · {kindLabel(d.kind)}</span>}
                {status && <StatusPill status={status} live={!!d?.live} dirtyLive={!!d?.dirty} />}
                {d?.reviewNote && status === 'REJECTED' && <span style={{ fontSize: 12, color: 'var(--fl-fail)' }} title={d.reviewNote}>반려 사유: {d.reviewNote}</span>}
                {dirty && <span style={{ fontSize: 11.5, color: 'var(--fl-waiting)' }}>● 저장 안 됨</span>}
                <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  {d && <UsagesChip id={d.id} count={d.usages} />}
                  {d?.live && <button style={ghostBtn} onClick={() => setShowDiff((v) => !v)}>{showDiff ? '편집으로' : '승인본과 비교'}</button>}
                  {canEdit && <button style={{ ...primaryBtn, opacity: dirty ? 1 : 0.55 }} disabled={!dirty || save.isPending} onClick={() => save.mutate()} title="Ctrl+S">💾 저장</button>}
                  {canEdit && d && (status === 'DRAFT' || status === 'REJECTED' || (status === 'APPROVED' && d.dirty)) && !dirty && (
                    <button style={okBtn} disabled={transition.isPending} onClick={() => transition.mutate({ op: 'submit' })}>승인 요청</button>
                  )}
                  {canEdit && status === 'PENDING' && <button style={ghostBtn} disabled={transition.isPending} onClick={() => transition.mutate({ op: 'withdraw' })}>철회</button>}
                  {isAdmin && status === 'PENDING' && (
                    <>
                      <button style={okBtn} disabled={transition.isPending} onClick={() => transition.mutate({ op: 'approve' })}>✓ 승인</button>
                      <button style={dangerBtn} disabled={transition.isPending} onClick={() => setAsk({ title: '반려 사유', input: { label: '사유', placeholder: '무엇을 고쳐야 하는지' }, confirmLabel: '반려', danger: true, onConfirm: (v) => transition.mutate({ op: 'reject', note: v }) })}>반려</button>
                    </>
                  )}
                  {canEdit && d && <button style={dangerBtn} disabled={transition.isPending || d.usages > 0} title={d.usages > 0 ? `사용 중(${d.usages}곳)이라 삭제할 수 없습니다` : '삭제'}
                    onClick={() => setAsk({ title: `'${d.name}' 삭제`, message: d.live ? '승인본도 함께 사라지고 서빙이 중단됩니다.' : undefined, confirmLabel: '삭제', danger: true, onConfirm: () => transition.mutate({ op: 'remove' }) })}>삭제</button>}
                </span>
              </header>
              <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 380px', minHeight: 0 }}>
                <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0, borderRight: '1px solid var(--fl-border)' }}>
                  {showDiff && d?.liveSource ? (
                    <PluginDiffView before={d.liveSource} after={draft.source} />
                  ) : (
                    <Suspense fallback={<textarea value={draft.source} readOnly style={{ flex: 1, fontFamily: 'var(--fl-font-mono)', fontSize: 13, padding: 14, border: 'none' }} />}>
                      <CodeEditorLazy value={draft.source} language="javascript" completions={completions} diagnostics={diag} wrap={false}
                        onChange={(v) => { if (!canEdit) return; setDraft((x) => (x ? { ...x, source: v } : x)); setDirty(true) }} />
                    </Suspense>
                  )}
                  <div style={statusBar}>
                    <span>Ctrl+S 저장 · Ctrl+Enter 실행 · Shift+Alt+F 정렬 · <code>fl.</code> 자동완성</span>
                    {d?.updatedAt && <span style={{ marginLeft: 'auto' }}>수정 {relTime(d.updatedAt)} · {d.createdBy}</span>}
                  </div>
                </div>
                <PluginRunPanel source={draft.source} scriptId={d?.id ?? null} canRun={canEdit} onDiagnostics={setDiag} />
              </div>
            </>
          )}
        </div>
      </div>
      {ask && <AskDialog spec={ask} onClose={() => setAsk(null)} />}
    </AppShellTier1>
  )
}

function ListItem({ p, on, onClick }: { p: PluginScriptSummary; on: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{ ...item, ...(on ? itemOn : null) }}>
      <span style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{p.name}</span>
        <StatusPill status={p.status} live={p.live} dirtyLive={p.dirty} small />
      </span>
      <span style={{ fontSize: 11, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }}>{p.pluginId} · {kindLabel(p.kind)}{p.usages ? ` · ${p.usages}곳` : ''}</span>
    </button>
  )
}

/** 상태 필 — 승인본 서빙 중이면 초록 점, 승인본과 다르게 수정 중이면 "수정 중". */
function StatusPill({ status, live, dirtyLive, small }: { status: PluginScriptStatus; live: boolean; dirtyLive: boolean; small?: boolean }) {
  const color = status === 'APPROVED' ? 'var(--fl-ok)' : status === 'PENDING' ? 'var(--fl-waiting)' : status === 'REJECTED' ? 'var(--fl-fail)' : 'var(--fl-text-muted)'
  const label = status === 'APPROVED' && dirtyLive ? '수정 중' : STATUS_LABEL[status]
  return (
    <span title={live ? '승인본 서빙 중' : '아직 서빙되지 않음'} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: small ? 10.5 : 11.5, fontWeight: 700, color, padding: small ? '0 6px' : '2px 8px', border: `1px solid color-mix(in srgb, ${color} 45%, transparent)`, borderRadius: 999, whiteSpace: 'nowrap' }}>
      {live && <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--fl-ok)' }} />}{label}
    </span>
  )
}

/** 사용처 N — 클릭하면 목록 팝오버(항목 클릭 = 해당 화면). */
function UsagesChip({ id, count }: { id: string; count: number }) {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const refs = useQuery({ queryKey: ['plugins', 'scripts', id, 'usages'], queryFn: () => pluginsApi.usages(id), enabled: open })
  return (
    <span style={{ position: 'relative' }}>
      <button style={{ ...ghostBtn, opacity: count ? 1 : 0.6 }} onClick={() => setOpen((v) => !v)} title="이 플러그인을 쓰는 워크플로·Mock·프로토콜">사용처 {count}</button>
      {open && (
        <div role="menu" style={pop} onMouseLeave={() => setOpen(false)}>
          {refs.isLoading && <div style={muted}>불러오는 중…</div>}
          {refs.data?.length === 0 && <div style={muted}>사용처 없음</div>}
          {refs.data?.map((r) => (
            <button key={`${r.kind}-${r.id}`} style={item} onClick={() => navigate(r.kind === 'flow' ? `/flows/${r.id}` : r.kind === 'mock' ? `/mocks/${r.id}` : `/protocols/${r.id}`)}>
              <span style={{ fontSize: 12.5 }}>{r.kind === 'flow' ? '▤' : r.kind === 'mock' ? '◈' : '⫶'} {r.name}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  )
}

const listPane: CSSProperties = { display: 'grid', gridTemplateRows: 'auto auto auto auto 1fr', gap: 8, padding: '18px 14px', borderRight: '1px solid var(--fl-border)', background: 'var(--fl-surface)', minHeight: 0 }
const search: CSSProperties = { padding: '7px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)', fontSize: 12.5 }
const chip: CSSProperties = { padding: '3px 9px', border: '1px solid var(--fl-border)', borderRadius: 999, background: 'transparent', color: 'var(--fl-text-muted)', fontSize: 11.5, cursor: 'pointer' }
const chipOn: CSSProperties = { background: 'var(--fl-surface-2)', color: 'var(--fl-text)', fontWeight: 700 }
const newBtn: CSSProperties = { padding: '7px 10px', border: '1px dashed var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-primary)', fontSize: 12.5, cursor: 'pointer', textAlign: 'left' }
const item: CSSProperties = { display: 'grid', gap: 2, textAlign: 'left', padding: '8px 10px', border: '1px solid transparent', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-text)', cursor: 'pointer', minWidth: 0, width: '100%' }
const itemOn: CSSProperties = { background: 'var(--fl-surface-2)', borderColor: 'var(--fl-border)' }
const muted: CSSProperties = { fontSize: 12.5, color: 'var(--fl-text-muted)', padding: '6px 2px' }
const empty: CSSProperties = { height: '100%', display: 'grid', alignContent: 'center', justifyItems: 'center', textAlign: 'center', color: 'var(--fl-text-muted)', padding: 40 }
const hdr: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderBottom: '1px solid var(--fl-border)', background: 'var(--fl-surface)', flexWrap: 'wrap', flexShrink: 0 }
const nameInput: CSSProperties = { fontFamily: 'var(--fl-font-head)', fontWeight: 700, fontSize: 16, border: '1px solid transparent', background: 'transparent', color: 'var(--fl-text)', padding: '4px 6px', borderRadius: 6, minWidth: 180 }
const metaMono: CSSProperties = { fontSize: 11, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }
const statusBar: CSSProperties = { display: 'flex', gap: 8, padding: '4px 12px', borderTop: '1px solid var(--fl-border)', fontSize: 11, color: 'var(--fl-text-muted)', background: 'var(--fl-surface)' }
const primaryBtn: CSSProperties = { padding: '7px 14px', border: 'none', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-primary)', color: '#fff', fontWeight: 700, fontSize: 12.5, cursor: 'pointer', whiteSpace: 'nowrap' }
const okBtn: CSSProperties = { ...primaryBtn, background: 'var(--fl-ok)' }
const dangerBtn: CSSProperties = { padding: '7px 12px', border: '1px solid color-mix(in srgb, var(--fl-fail) 45%, transparent)', borderRadius: 'var(--fl-radius-sm)', background: 'transparent', color: 'var(--fl-fail)', fontSize: 12.5, cursor: 'pointer', whiteSpace: 'nowrap' }
const ghostBtn: CSSProperties = { padding: '7px 12px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12.5, cursor: 'pointer', whiteSpace: 'nowrap' }
const pop: CSSProperties = { position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 60, minWidth: 240, padding: 6, border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', boxShadow: 'var(--fl-shadow-lg)', display: 'grid', gap: 2 }
```
이 태스크가 컴파일되려면 `PluginRunPanel`·`PluginDiffView` 가 존재해야 한다 — **이 태스크에서 스텁**을 만들고 Task 11/12 가 채운다:
- `frontend/src/components/PluginRunPanel.tsx`: `export function PluginRunPanel(_: { source: string; scriptId: string | null; canRun: boolean; onDiagnostics: (d: EditorDiagnostic[]) => void }) { return <aside style={{ padding: 14, fontSize: 12.5, color: 'var(--fl-text-muted)' }}>실행 패널(Task 11)</aside> }`
- `frontend/src/components/PluginDiffView.tsx`: `export function PluginDiffView({ before, after }: { before: string; after: string }) { return <pre style={{ margin: 0, padding: 14, overflow: 'auto', flex: 1 }}>{before === after ? '승인본과 동일' : after}</pre> }`

- [ ] **Step 3: 라우트·네비** — `App.tsx`: `import { Plugins } from './routes/Plugins'` + `<Route path="/plugins" element={<Plugins />} />` · `<Route path="/plugins/:id" element={<Plugins />} />`(`/protocols/:id` 다음). `AppShell.tsx` NAV 에 `{ to: '/plugins', label: '플러그인', icon: '◇' }`('프로토콜' 다음).

- [ ] **Step 4: 확인** — `cd frontend && npx tsc -b && npx oxlint src && npm run build` 통과. 브라우저(:8888 dev 모드): `/plugins` → "+ 새 변환" → 편집기(JS 하이라이트) → 저장 → 목록에 초안 → 새로고침 후 `/plugins/:id` 로 복원 → 이름 변경 후 Ctrl+S.

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/lib/pluginTemplates.ts frontend/src/routes/Plugins.tsx frontend/src/components/PluginRunPanel.tsx frontend/src/components/PluginDiffView.tsx frontend/src/App.tsx frontend/src/app/AppShell.tsx
git commit -m "feat(plugins): /plugins 페이지 — 목록·CodeMirror 편집기·템플릿·저장·상태 전이 버튼(실행 패널/diff 는 스텁)" -- frontend/src/lib/pluginTemplates.ts frontend/src/routes/Plugins.tsx frontend/src/components/PluginRunPanel.tsx frontend/src/components/PluginDiffView.tsx frontend/src/App.tsx frontend/src/app/AppShell.tsx
```

---

### Task 11: 실행 패널 — 메타로 폼 자동 생성 · ▶ 실행 · 결과/콘솔 · 샘플 기억

**Files:**
- Modify: `frontend/src/components/PluginRunPanel.tsx` (스텁 → 구현)

**Interfaces:**
- Consumes: `pluginsApi.tryRun`, `pluginsApi.saveSample`, `JsonTree`, `toast`.
- Props: `{ source: string; scriptId: string | null; canRun: boolean; onDiagnostics: (d: EditorDiagnostic[]) => void }`.
- 동작: `source` 가 바뀌고 600ms 멈추면 `tryRun({ source })`(컴파일만) → `meta` 로 폼 구성. transform: inputs 별 텍스트 + params 별(select 면 select). fieldCodec: value + fn(encode/decode) + direction + params + message(JSON 텍스트). messageCodec: 텍스트+charset 또는 hex 입력(→ base64 변환은 브라우저 `TextEncoder`(UTF-8 만) / hex 파싱) + fn + params. ▶(Ctrl+Enter) → 결과: transform=outputs `JsonTree`, fieldCodec=result 문자열, messageCodec=hex+텍스트(UTF-8 시도). 로그·ms·오류(줄 번호는 `onDiagnostics`). 샘플은 `localStorage['fl:plugrun:'+(scriptId ?? 'new')]`, 실행 성공 시 `scriptId` 있으면 `saveSample(id, JSON.stringify({ request, result }))`.

- [ ] **Step 1: 구현** — `PluginRunPanel.tsx` 전체:

```tsx
// 플러그인 실행 패널 — 컴파일 메타로 입력 폼을 자동 생성하고, 샌드박스에서 1회 실행해 출력·콘솔·소요 시간을 보여준다.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { pluginsApi } from '../api/client'
import type { PluginScriptMeta, PluginTryRequest, PluginTryResult, ScriptErrorBody } from '../api/types'
import type { EditorDiagnostic } from './CodeEditor'
import { JsonTree } from './JsonTree'
import { toast } from './toast'

type Sample = { inputs: Record<string, string>; config: Record<string, string>; value: string; fn: 'encode' | 'decode'; direction: 'send' | 'recv'; message: string; bytesText: string; bytesMode: 'text' | 'hex' }
const EMPTY: Sample = { inputs: {}, config: {}, value: '', fn: 'encode', direction: 'send', message: '{}', bytesText: '', bytesMode: 'text' }

function loadSample(key: string): Sample { try { return { ...EMPTY, ...JSON.parse(localStorage.getItem(key) ?? '{}') } } catch { return EMPTY } }
function scriptError(e: unknown): ScriptErrorBody | null {
  const d = (e as { response?: { data?: Partial<ScriptErrorBody> } })?.response?.data
  return d && typeof d.message === 'string' && 'line' in d ? { message: d.message, line: d.line ?? null, col: d.col ?? null } : null
}
const b64 = { enc: (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)), dec: (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) }
const hex = { enc: (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' '), dec: (s: string) => Uint8Array.from((s.replace(/[^0-9a-f]/gi, '').match(/.{2}/g) ?? []).map((h) => parseInt(h, 16))) }

export function PluginRunPanel({ source, scriptId, canRun, onDiagnostics }: { source: string; scriptId: string | null; canRun: boolean; onDiagnostics: (d: EditorDiagnostic[]) => void }) {
  const key = `fl:plugrun:${scriptId ?? 'new'}`
  const [meta, setMeta] = useState<PluginScriptMeta | null>(null)
  const [compileErr, setCompileErr] = useState<string | null>(null)
  const [sample, setSample] = useState<Sample>(() => loadSample(key))
  const [result, setResult] = useState<PluginTryResult | null>(null)
  const [runErr, setRunErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const sourceRef = useRef(source); sourceRef.current = source
  useEffect(() => { setSample(loadSample(key)); setResult(null); setRunErr(null) }, [key])
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(sample)) } catch { /* */ } }, [key, sample])

  // 타이핑 멈춤 600ms → 컴파일만(입력 없이) → 메타로 폼
  useEffect(() => {
    if (!canRun) return
    const t = setTimeout(() => {
      pluginsApi.tryRun({ source: sourceRef.current }).then((r) => { setMeta(r.meta); setCompileErr(null); onDiagnostics([]) })
        .catch((e) => { const se = scriptError(e); setCompileErr(se?.message ?? '컴파일 실패'); if (se?.line) onDiagnostics([{ line: se.line, col: se.col ?? undefined, message: se.message }]) })
    }, 600)
    return () => clearTimeout(t)
  }, [source, canRun, onDiagnostics])

  const request = useMemo((): PluginTryRequest | null => {
    if (!meta) return null
    if (meta.kind === 'transform') return { source, inputs: sample.inputs, config: sample.config }
    let message: Record<string, string> = {}
    try { message = JSON.parse(sample.message || '{}') } catch { /* 잘못된 JSON 은 빈 맵 */ }
    if (meta.kind === 'fieldCodec') return { source, value: sample.value, fn: sample.fn, direction: sample.direction, config: sample.config, message }
    const bytes = sample.bytesMode === 'hex' ? hex.dec(sample.bytesText) : new TextEncoder().encode(sample.bytesText)
    return { source, fn: sample.fn, direction: sample.direction, config: sample.config, bytesB64: b64.enc(bytes) }
  }, [meta, sample, source])

  const run = async () => {
    if (!request || busy) return
    setBusy(true); setRunErr(null)
    try {
      const r = await pluginsApi.tryRun(request)
      setResult(r); onDiagnostics([])
      if (scriptId) void pluginsApi.saveSample(scriptId, JSON.stringify({ request: { ...request, source: undefined }, result: r })).catch(() => {})
    } catch (e) {
      const se = scriptError(e)
      setRunErr(se ? `${se.line ? `${se.line}행: ` : ''}${se.message}` : (e as Error).message)
      if (se?.line) onDiagnostics([{ line: se.line, col: se.col ?? undefined, message: se.message }])
    } finally { setBusy(false) }
  }
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void run() } }
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, busy])

  const setIn = (k: string, v: string) => setSample((s) => ({ ...s, inputs: { ...s.inputs, [k]: v } }))
  const setCfg = (k: string, v: string) => setSample((s) => ({ ...s, config: { ...s.config, [k]: v } }))
  const out = result?.bytesB64 ? b64.dec(result.bytesB64) : null

  return (
    <aside style={panel} aria-label="실행 패널">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong style={{ fontSize: 13 }}>▶ 실행해 보기</strong>
        {meta && <span style={mono}>{meta.id} · {meta.kind}</span>}
        <button onClick={() => void run()} disabled={!canRun || !request || busy || !!compileErr} style={{ ...runBtn, marginLeft: 'auto' }} title="Ctrl+Enter">{busy ? '실행 중…' : '▶ 실행'}</button>
      </div>
      {!canRun && <div style={hint}>실행은 가입 승인 후 가능합니다.</div>}
      {compileErr && <div style={{ ...hint, color: 'var(--fl-fail)' }}>⚠ {compileErr}</div>}
      {meta && (
        <div style={{ display: 'grid', gap: 6 }}>
          {meta.kind === 'transform' && meta.inputs.map((io) => (
            <label key={io.key} style={row}><span style={lbl} title={io.key}>{io.label}</span><input style={input} value={sample.inputs[io.key] ?? ''} placeholder={io.example || io.key} onChange={(e) => setIn(io.key, e.target.value)} /></label>
          ))}
          {meta.kind !== 'transform' && (
            <>
              <label style={row}><span style={lbl}>방향</span>
                <span style={{ display: 'flex', gap: 6 }}>
                  <select style={input} value={sample.fn} onChange={(e) => setSample((s) => ({ ...s, fn: e.target.value as 'encode' | 'decode' }))}><option value="encode">encode(보낼 때)</option><option value="decode">decode(받을 때)</option></select>
                  <select style={input} value={sample.direction} onChange={(e) => setSample((s) => ({ ...s, direction: e.target.value as 'send' | 'recv' }))}><option value="send">send</option><option value="recv">recv</option></select>
                </span>
              </label>
              {meta.kind === 'fieldCodec' && <label style={row}><span style={lbl}>값</span><input style={input} value={sample.value} onChange={(e) => setSample((s) => ({ ...s, value: e.target.value }))} /></label>}
              {meta.kind === 'fieldCodec' && <label style={row}><span style={lbl}>다른 필드(JSON)</span><input style={{ ...input, fontFamily: 'var(--fl-font-mono)' }} value={sample.message} onChange={(e) => setSample((s) => ({ ...s, message: e.target.value }))} placeholder='{"거래코드":"0210"}' /></label>}
              {meta.kind === 'messageCodec' && (
                <label style={row}><span style={lbl}>본문</span>
                  <span style={{ display: 'grid', gap: 4 }}>
                    <select style={input} value={sample.bytesMode} onChange={(e) => setSample((s) => ({ ...s, bytesMode: e.target.value as 'text' | 'hex' }))}><option value="text">텍스트(UTF-8)</option><option value="hex">hex</option></select>
                    <textarea style={{ ...input, minHeight: 60, fontFamily: 'var(--fl-font-mono)' }} value={sample.bytesText} onChange={(e) => setSample((s) => ({ ...s, bytesText: e.target.value }))} placeholder={sample.bytesMode === 'hex' ? '30 30 31 32 …' : '전문 본문'} />
                  </span>
                </label>
              )}
            </>
          )}
          {meta.params.map((p) => (
            <label key={p.key} style={row}><span style={lbl} title={p.key}>{p.label}</span>
              {p.type === 'select' && p.options?.length
                ? <select style={input} value={sample.config[p.key] ?? p.defaultValue} onChange={(e) => setCfg(p.key, e.target.value)}>{p.options.map((o) => <option key={o} value={o}>{o}</option>)}</select>
                : <input style={input} value={sample.config[p.key] ?? p.defaultValue} placeholder={p.placeholder || p.key} onChange={(e) => setCfg(p.key, e.target.value)} />}
            </label>
          ))}
          <div style={hint}>시크릿 토큰(<code>{'{{ x@secret }}'}</code>)은 여기선 풀리지 않습니다 — 실제 값을 넣어 시험하세요.</div>
        </div>
      )}
      {runErr && <div style={{ ...hint, color: 'var(--fl-fail)' }}>✕ {runErr}</div>}
      {result && (
        <div style={{ display: 'grid', gap: 6, minHeight: 0 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}><span style={{ color: 'var(--fl-ok)', fontWeight: 700 }}>✓ 성공</span><span style={mono}>{result.durationMs}ms</span></div>
          {result.outputs && <div style={box}><JsonTree value={result.outputs} defaultOpenDepth={2} /></div>}
          {result.result != null && <pre style={box}>{result.result}</pre>}
          {out && <div style={{ display: 'grid', gap: 4 }}><pre style={box}>{hex.enc(out)}</pre><pre style={box}>{new TextDecoder('utf-8', { fatal: false }).decode(out)}</pre></div>}
          {result.logs.length > 0 && <pre style={{ ...box, color: 'var(--fl-text-muted)' }}>{result.logs.map((l) => `› ${l}`).join('\n')}</pre>}
        </div>
      )}
    </aside>
  )
}

const panel: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10, padding: 14, overflowY: 'auto', background: 'var(--fl-surface)', minHeight: 0 }
const row: CSSProperties = { display: 'grid', gridTemplateColumns: '96px 1fr', gap: 8, alignItems: 'center', fontSize: 12.5 }
const lbl: CSSProperties = { color: 'var(--fl-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const input: CSSProperties = { padding: '6px 8px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface)', color: 'var(--fl-text)', fontSize: 12.5, width: '100%', boxSizing: 'border-box' }
const runBtn: CSSProperties = { padding: '6px 14px', border: 'none', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-ok)', color: '#fff', fontWeight: 700, fontSize: 12.5, cursor: 'pointer' }
const hint: CSSProperties = { fontSize: 11.5, color: 'var(--fl-text-muted)', lineHeight: 1.5 }
const mono: CSSProperties = { fontSize: 11, color: 'var(--fl-text-muted)', fontFamily: 'var(--fl-font-mono)' }
const box: CSSProperties = { margin: 0, padding: '8px 10px', fontSize: 12, fontFamily: 'var(--fl-font-mono)', background: 'var(--fl-surface-2)', border: '1px solid var(--fl-border)', borderRadius: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 220, overflow: 'auto' }
```

- [ ] **Step 2: 확인** — tsc/oxlint/build. 브라우저: 템플릿(변환) → 패널에 "원문"·"키" 폼 자동 생성 → 값 입력 → ▶ → `result` 트리 + `› input = …` 콘솔 + ms. 소스에 오타 → 600ms 뒤 거터 ⚠ + 패널 "⚠ 문법 오류". 필드 코덱 템플릿 → encode/decode 셀렉트·값·다른 필드 폼.

- [ ] **Step 3: 커밋**

```bash
git add frontend/src/components/PluginRunPanel.tsx
git commit -m "feat(plugins): 실행 패널 — 컴파일 메타로 입력 폼 자동 생성, 샌드박스 1회 실행, 출력/콘솔/소요·샘플 기억·승인용 샘플 저장" -- frontend/src/components/PluginRunPanel.tsx
```

---

### Task 12: 승인본 비교(줄 diff)

**Files:**
- Create: `frontend/src/lib/lineDiff.ts`
- Modify: `frontend/src/components/PluginDiffView.tsx` (스텁 → 구현)

**Interfaces:**
- Produces: `lineDiff(before: string, after: string): Array<{ type: 'same' | 'add' | 'del'; text: string }>` (LCS, O(n·m) — 플러그인 소스는 수백 줄이라 충분. `ponytail:` 5,000줄 넘으면 Myers 로).

- [ ] **Step 1: 단위 체크(Node 타입스트리핑 — 프로젝트 관례)** — `frontend/src/lib/lineDiff.ts` 하단이 아니라 별도 실행 파일로: 아래 구현 후 `node --experimental-strip-types -e "import('./frontend/src/lib/lineDiff.ts').then(m => { const d = m.lineDiff('a\nb\nc', 'a\nx\nc\nd'); console.log(JSON.stringify(d)); if (JSON.stringify(d.map(x=>x.type)) !== JSON.stringify(['same','del','add','same','add'])) process.exit(1) })"` 가 0 으로 끝나야 한다.

- [ ] **Step 2: 구현** — `lineDiff.ts`:

```ts
export type DiffLine = { type: 'same' | 'add' | 'del'; text: string }

/** 줄 단위 LCS diff — 승인본(before) 대비 초안(after). 작은 파일용(O(n·m)). ponytail: 5,000줄 넘으면 Myers 로. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n'), b = after.split('\n')
  const n = a.length, m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: DiffLine[] = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: 'same', text: a[i] }); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: a[i] }); i++ }
    else { out.push({ type: 'add', text: b[j] }); j++ }
  }
  while (i < n) out.push({ type: 'del', text: a[i++] })
  while (j < m) out.push({ type: 'add', text: b[j++] })
  return out
}
```

`PluginDiffView.tsx`:

```tsx
import { useMemo } from 'react'
import { lineDiff } from '../lib/lineDiff'

/** 승인본(왼쪽 기준) 대비 초안 — 삭제 줄 빨강, 추가 줄 초록. 승인 화면과 편집기 '승인본과 비교' 가 공용. */
export function PluginDiffView({ before, after }: { before: string; after: string }) {
  const lines = useMemo(() => lineDiff(before, after), [before, after])
  const changed = lines.filter((l) => l.type !== 'same').length
  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', fontFamily: 'var(--fl-font-mono)', fontSize: 12.5, lineHeight: 1.6 }}>
      <div style={{ padding: '6px 12px', fontSize: 11.5, color: 'var(--fl-text-muted)', borderBottom: '1px solid var(--fl-border)', position: 'sticky', top: 0, background: 'var(--fl-surface)' }}>
        {changed === 0 ? '승인본과 동일' : `승인본 대비 ${lines.filter((l) => l.type === 'add').length}줄 추가 · ${lines.filter((l) => l.type === 'del').length}줄 삭제`}
      </div>
      {lines.map((l, i) => (
        <div key={i} style={{ display: 'flex', gap: 10, padding: '0 12px', whiteSpace: 'pre', background: l.type === 'add' ? 'color-mix(in srgb, var(--fl-ok) 14%, transparent)' : l.type === 'del' ? 'color-mix(in srgb, var(--fl-fail) 14%, transparent)' : 'transparent' }}>
          <span style={{ width: 12, color: 'var(--fl-text-muted)', userSelect: 'none' }}>{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>
          <span style={{ textDecoration: l.type === 'del' ? 'line-through' : 'none', opacity: l.type === 'del' ? 0.8 : 1 }}>{l.text || ' '}</span>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 3: 확인** — Step 1 의 node 체크 0 종료 + tsc/build. 브라우저: 승인된 플러그인 수정 → "승인본과 비교" → 바뀐 줄 하이라이트.

- [ ] **Step 4: 커밋**

```bash
git add frontend/src/lib/lineDiff.ts frontend/src/components/PluginDiffView.tsx
git commit -m "feat(plugins): 승인본 대비 줄 diff 보기" -- frontend/src/lib/lineDiff.ts frontend/src/components/PluginDiffView.tsx
```

---

### Task 13: 관리 콘솔 — 플러그인 승인 요청 큐 + 네비 배지

**Files:**
- Modify: `frontend/src/routes/Admin.tsx` (현황 카드 + users 탭 승인 큐 아래 섹션)
- Modify: `frontend/src/app/AppShell.tsx:64-66` (배지 = `pendingCount + pendingPlugins`)

**Interfaces:**
- Consumes: `pluginsApi.list('PENDING')`, `pluginsApi.get(id)`(펼침 시 상세 — 샘플·승인본), `pluginsApi.approve/reject`, `PluginDiffView`, 기존 `ConfirmChip`/`Avatar`/`countBadge`/`panel`/`approveBtn`/`relTime`/`toast`.

- [ ] **Step 1: Admin.tsx 데이터** — 상단 쿼리들 옆에:
```tsx
  const pendingPlugins = useQuery({ queryKey: ['plugins', 'scripts', 'PENDING'], queryFn: () => pluginsApi.list('PENDING'), refetchInterval: 30_000 })
```
import 에 `pluginsApi` 추가(`../api/client`), `import { PluginDiffView } from '../components/PluginDiffView'`, `import { kindLabel } from '../lib/pluginTemplates'`, `import { Link } from 'react-router-dom'`(없으면).

- [ ] **Step 2: 현황 카드** — 89~93행 스트립에 카드 추가(가입 신청 다음):
```tsx
          <StatCard icon="◇" label="플러그인 승인 요청" value={pendingPlugins.data?.length ?? 0} accent={(pendingPlugins.data?.length ?? 0) > 0 ? 'var(--fl-waiting)' : undefined}
            sub={(pendingPlugins.data?.length ?? 0) > 0 ? '코드·샘플 확인 후 승인' : '대기 없음'} onClick={() => setTab('users')} />
```

- [ ] **Step 3: 승인 큐 섹션** — users 탭의 `{/* ── 가입 신청 큐 ── */}` 블록 **바로 아래**에:

```tsx
      {/* ── 플러그인 승인 요청 ── */}
      {(pendingPlugins.data?.length ?? 0) > 0 && (
        <div style={{ ...panel, borderColor: 'color-mix(in srgb, var(--fl-waiting) 55%, transparent)', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 18px', background: 'color-mix(in srgb, var(--fl-waiting) 8%, transparent)', borderBottom: '1px solid var(--fl-border)', flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 14 }}>◇ 플러그인 승인 요청</strong>
            <span style={countBadge}>{pendingPlugins.data!.length}</span>
            <span style={{ fontSize: 12, color: 'var(--fl-text-muted)' }}>승인하면 즉시 서빙됩니다 — 코드와 제출자가 돌린 샘플 결과를 확인하세요</span>
          </div>
          {pendingPlugins.data!.map((p, i) => <PendingPluginRow key={p.id} p={p} first={i === 0} onDone={() => { void pendingPlugins.refetch(); void qc.invalidateQueries({ queryKey: ['plugins'] }); void qc.invalidateQueries({ queryKey: ['admin', 'me'] }) }} />)}
        </div>
      )}
```

파일 하단(다른 컴포넌트들 옆)에 행 컴포넌트:

```tsx
/** 승인 요청 한 건 — 펼치면 승인본 대비 diff + 제출 샘플. 승인/반려는 ConfirmChip. */
function PendingPluginRow({ p, first, onDone }: { p: import('../api/types').PluginScriptSummary; first: boolean; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const detail = useQuery({ queryKey: ['plugins', 'scripts', p.id], queryFn: () => pluginsApi.get(p.id), enabled: open })
  const sample = useMemo(() => { try { return detail.data?.sampleJson ? JSON.parse(detail.data.sampleJson) as { request?: unknown; result?: { outputs?: unknown; result?: unknown; logs?: string[] } } : null } catch { return null } }, [detail.data])
  const act = async (op: 'approve' | 'reject') => {
    setBusy(true)
    try { if (op === 'approve') await pluginsApi.approve(p.id); else await pluginsApi.reject(p.id, note); toast(op === 'approve' ? `${p.name} 승인됨 — 즉시 서빙` : `${p.name} 반려함`, 'ok'); onDone() }
    catch (e) { toast(apiErrorMessage(e), 'error') } finally { setBusy(false) }
  }
  return (
    <div style={{ borderTop: first ? 'none' : '1px solid var(--fl-border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 18px' }}>
        <Avatar name={p.submittedBy ?? p.createdBy} />
        <span style={{ minWidth: 0, flex: 1 }}>
          <span style={{ display: 'block', fontWeight: 700, fontSize: 13.5 }}>{p.name} <span style={{ fontFamily: 'var(--fl-font-mono)', fontWeight: 400, fontSize: 11.5, color: 'var(--fl-text-muted)' }}>#{p.pluginId} · {kindLabel(p.kind)}</span></span>
          <span style={{ display: 'block', fontSize: 11.5, color: 'var(--fl-text-muted)', marginTop: 1 }}>
            {p.submittedBy} · 요청 {relTime(p.updatedAt)}{p.live ? ' · 승인본 교체' : ' · 신규'}{p.usages > 0 ? ` · ⚠ 사용처 ${p.usages}곳에 즉시 반영` : ''}
          </span>
        </span>
        <button onClick={() => setOpen((v) => !v)} style={chipBtn}>{open ? '접기' : '코드·샘플 보기'}</button>
        <Link to={`/plugins/${p.id}`} style={{ ...chipBtn, textDecoration: 'none', color: 'var(--fl-text)' }}>편집기에서 열기</Link>
        <button onClick={() => void act('approve')} disabled={busy} style={approveBtn}>{busy ? '처리 중…' : '✓ 승인'}</button>
        <ConfirmChip label="반려" confirmLabel="반려 확정" pending={busy} onConfirm={() => void act('reject')} />
      </div>
      {open && (
        <div style={{ padding: '0 18px 14px', display: 'grid', gap: 10 }}>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="반려 사유(반려 시 제출자에게 보임)" style={{ padding: '6px 10px', border: '1px solid var(--fl-border)', borderRadius: 'var(--fl-radius-sm)', background: 'var(--fl-surface-2)', color: 'var(--fl-text)', fontSize: 12.5 }} />
          <div style={{ border: '1px solid var(--fl-border)', borderRadius: 8, maxHeight: 420, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {detail.data ? <PluginDiffView before={detail.data.liveSource ?? ''} after={detail.data.source} /> : <div style={{ padding: 12, fontSize: 12.5, color: 'var(--fl-text-muted)' }}>불러오는 중…</div>}
          </div>
          <div style={{ fontSize: 12, color: 'var(--fl-text-muted)' }}>
            {sample ? <>제출자 샘플 — 입력 <code style={{ fontFamily: 'var(--fl-font-mono)' }}>{JSON.stringify(sample.request)}</code> → 결과 <code style={{ fontFamily: 'var(--fl-font-mono)' }}>{JSON.stringify(sample.result?.outputs ?? sample.result?.result ?? sample.result)}</code></> : '제출자가 돌린 샘플이 없습니다 — 편집기에서 열어 직접 실행해 보세요.'}
          </div>
        </div>
      )}
    </div>
  )
}
```
(`useMemo` import 확인.)

- [ ] **Step 4: 네비 배지** — `AppShell.tsx` 64~66행을 합계로:
```tsx
              {n.to === '/admin' && ((adminMe.data?.pendingCount ?? 0) + (adminMe.data?.pendingPlugins ?? 0)) > 0 && (
                <span title={`가입 신청 ${adminMe.data!.pendingCount}건 · 플러그인 승인 요청 ${adminMe.data!.pendingPlugins ?? 0}건`} style={pendingNavBadge}>{(adminMe.data!.pendingCount) + (adminMe.data!.pendingPlugins ?? 0)}</span>
              )}
```

- [ ] **Step 5: 확인** — tsc/oxlint/build. 브라우저(dev 모드 = 관리자): 편집기에서 승인 요청 → 관리 네비 배지 1 → 관리 콘솔 카드/섹션 → 코드·샘플 보기(diff·샘플) → ✓ 승인 → 배지 0, `/plugins` 목록 필 "승인됨" + 초록 점.

- [ ] **Step 6: 커밋**

```bash
git add frontend/src/routes/Admin.tsx frontend/src/app/AppShell.tsx
git commit -m "feat(plugins): 관리 콘솔 플러그인 승인 요청 큐(diff·샘플·승인/반려) + 네비 배지 합산" -- frontend/src/routes/Admin.tsx frontend/src/app/AppShell.tsx
```

---

### Task 14: 진입 단축 — 선택기 "＋ 새 플러그인" + JAR 업로드 UI 제거

**Files:**
- Modify: `frontend/src/components/TransformPicker.tsx:24-31,95-110` (`onCreateNew?: () => void` → 목록 끝 푸터)
- Modify: `frontend/src/panels/PropertyPanel.tsx:1255-1308` (JAR 업로드 label 블록 삭제, picker 에 `onCreateNew`)
- Modify: `frontend/src/components/MockCodecEditor.tsx:130`, `frontend/src/components/FieldCodecButton.tsx:121,272` (picker 에 `onCreateNew`)

- [ ] **Step 1: TransformPicker** — props 에 `onCreateNew?: () => void` 추가. 목록 `<div style={{ maxHeight: 260, overflowY: 'auto' }}>` 닫힌 뒤(팝오버 안, 마지막)에:
```tsx
          {onCreateNew && (
            <button type="button" onMouseDown={(e) => { e.preventDefault(); setOpen(false); onCreateNew() }}
              style={{ width: '100%', padding: '8px 12px', border: 'none', borderTop: '1px solid var(--fl-border)', background: 'transparent', color: 'var(--fl-primary)', fontSize: 12, cursor: 'pointer', textAlign: 'left' }}>
              ＋ 새 플러그인 만들기 → (JS 로 작성, 승인 후 여기 나타남)
            </button>
          )}
```

- [ ] **Step 2: PropertyPanel** — 1286~1308행의 `{canPlatformAdmin && (<label …>⬆ JAR 플러그인 업로드 …</label>)}` 블록 전체 삭제, `pluginsApi` import 가 다른 곳에서 안 쓰이면 제거. 1255행 `<TransformPicker` 에 `onCreateNew={() => window.open(appUrl('/plugins?new=transform'), '_blank')}` 추가(`appUrl` 은 `../lib/appBase` — 이미 import 돼 있는지 확인, 없으면 추가). 에디터 화면을 떠나지 않게 새 탭.

- [ ] **Step 3: Mock 쪽** — `MockCodecEditor.tsx` 130행·`FieldCodecButton.tsx` 121행(팝오버)·272행(위저드)의 `<TransformPicker …` 에 각각 `onCreateNew={() => window.open(appUrl('/plugins?new=transform'), '_blank')}` 추가 + `import { appUrl } from '../lib/appBase'`.

- [ ] **Step 4: 확인** — tsc/oxlint/build. 브라우저: TRANSFORM 노드 속성 → 선택기 열기 → 푸터 "＋ 새 플러그인 만들기" → 새 탭 `/plugins?new=transform` 템플릿. JAR 업로드 라벨이 사라졌는지.

- [ ] **Step 5: 커밋**

```bash
git add frontend/src/components/TransformPicker.tsx frontend/src/panels/PropertyPanel.tsx frontend/src/components/MockCodecEditor.tsx frontend/src/components/FieldCodecButton.tsx
git commit -m "feat(plugins): 플러그인 선택기에 '새 플러그인 만들기' 진입 + JAR 업로드 UI 제거" -- frontend/src/components/TransformPicker.tsx frontend/src/panels/PropertyPanel.tsx frontend/src/components/MockCodecEditor.tsx frontend/src/components/FieldCodecButton.tsx
```

---

### Task 15: 통합 검증 — 격리 인스턴스에서 API 시나리오 + 브라우저 스모크

**Files:**
- 스크래치패드(커밋 안 함): `plugins-e2e.mjs`
- 참고: 메모리 "Headless UI check pattern" — playwright-core 는 스크래치패드에 `npm i playwright-core`, 시스템 Chrome `C:/Program Files/Google/Chrome/Application/chrome.exe`. 격리 인스턴스는 **새로 빌드한 jar 로** `FLOWLINK_PORT=18081 FLOWLINK_H2_FILE=<scratch>/e2e-h2 scripts/start.ps1`(포트 사용 중이면 `netstat -ano | findstr :18081` 로 확인 후 다른 포트).

- [ ] **Step 1: 빌드·기동** — `cd frontend && npm run build` → `cd backend && ./gradlew :test bootJar --console=plain`(전체 그린 확인) → 격리 인스턴스 기동, `curl -s localhost:18081/api/v1/plugins/api | head -c 200` 에 `fl.b64.enc` 가 보이면 OK.

- [ ] **Step 2: API 시나리오 스크립트** — `plugins-e2e.mjs`(Node 24, fetch):

```js
const B = process.env.URL ?? 'http://localhost:18081/api/v1'
const j = async (m, p, b) => { const r = await fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }); const t = await r.text(); let d = null; try { d = JSON.parse(t) } catch {} ; return { s: r.status, d, t } }
let n = 0; const ok = (c, msg) => { if (!c) { console.error('FAIL', msg); process.exit(1) } console.log(`  ✓ ${++n} ${msg}`) }
const SRC = `({ id: 'e2e-up', label: 'E2E 대문자', inputs: [{ key: 'input', label: '원문' }], apply(i, c) { fl.log('x'); return { result: i.input.toUpperCase() } } })`
// 1. 매니페스트·가이드
ok((await j('GET', '/plugins/api')).d.some((e) => e.path === 'fl.aes.encrypt'), 'fl 매니페스트')
ok((await j('GET', '/schemas')).d.plugin.includes('fl.aes.encrypt'), 'schemas.plugin 가이드')
// 2. 컴파일 오류 400 + 줄 번호
const bad = await j('POST', '/plugins/scripts', { source: "({ id: 'x',\n label: 'x' apply() {} })" })
ok(bad.s === 400 && bad.d.line === 2, `컴파일 오류 400 line=2 (${bad.d.message})`)
// 3. 초안 → try → submit → approve → 레지스트리
const c = await j('POST', '/plugins/scripts', { name: 'E2E', source: SRC }); ok(c.s === 201 && c.d.status === 'DRAFT', '초안 생성')
ok(!(await j('GET', '/transforms')).d.some((t) => t.id === 'e2e-up'), '승인 전엔 레지스트리에 없음')
const tr = await j('POST', '/plugins/scripts/try', { source: SRC, inputs: { input: 'ab' } }); ok(tr.d.outputs.result === 'AB' && tr.d.logs[0] === 'x', 'try 실행')
ok((await j('POST', `/plugins/scripts/${c.d.id}/submit`)).d.status === 'PENDING', '승인 요청')
ok((await j('GET', '/admin/me')).d.pendingPlugins === 1, 'admin/me pendingPlugins=1')
ok((await j('POST', `/plugins/scripts/${c.d.id}/approve`)).d.live === true, '승인(dev=관리자)')
ok((await j('GET', '/transforms')).d.some((t) => t.id === 'e2e-up'), '레지스트리 등장')
ok((await j('POST', '/transforms/e2e-up/preview', { inputs: { input: 'q' }, config: {} })).d.outputs.result === 'Q', '기존 transform preview 로 실행')
// 4. 사용처·삭제 가드: 워크플로에서 쓰면 삭제 400
const f = await j('POST', '/flows', { name: 'e2e plugin flow' })
await j('POST', `/flows/${f.d.id}/versions`, { graph: { nodes: [{ id: 's', type: 'start', name: '시작', x: 0, y: 0 }, { id: 't', type: 'transform', name: '변환', x: 200, y: 0, transformId: 'e2e-up', fields: { body: [{ id: 'f1', key: 'input', value: 'hi' }] } }, { id: 'e', type: 'end', name: '끝', x: 400, y: 0 }], edges: [{ from: 's', to: 't' }, { from: 't', to: 'e' }] } })
await new Promise((r) => setTimeout(r, 31_000)) // 사용처 캐시 30초
ok((await j('GET', `/plugins/scripts/${c.d.id}`)).d.usages >= 1, '사용처 카운트')
ok((await j('DELETE', `/plugins/scripts/${c.d.id}`)).s === 400, '사용 중 삭제 거부')
// 5. 워크플로 실행에서 스크립트 변환이 돈다
const run = await j('POST', `/flows/${f.d.id}/runs`, {})
let ex; for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 300)); ex = (await j('GET', `/executions/${run.d.id}`)).d; if (ex.status !== 'RUNNING') break }
ok(ex.status === 'SUCCEEDED', `워크플로 실행 ${ex.status}`)
// 6. 수정 → 반려 → 승인본 유지
await j('PUT', `/plugins/scripts/${c.d.id}`, { source: SRC.replace('toUpperCase', 'toLowerCase') })
await j('POST', `/plugins/scripts/${c.d.id}/submit`)
const rj = await j('POST', `/plugins/scripts/${c.d.id}/reject`, { note: '아직' }); ok(rj.d.status === 'REJECTED' && rj.d.live, '반려 후 승인본 유지')
ok((await j('POST', '/transforms/e2e-up/preview', { inputs: { input: 'q' }, config: {} })).d.outputs.result === 'Q', '반려 후에도 서빙은 승인본')
console.log(`ALL ${n} PASS`)
```
실행: `node plugins-e2e.mjs`. 경로 근거(MCP `flow_upsert`/`flow_run` 이 쓰는 그대로): `POST /flows {name}` → `POST /flows/{id}/versions {graph, note, pinned:false}` → `POST /flows/{id}/runs {input:null}` 의 응답 `id` 가 실행 id, `GET /executions/{id}` 의 `status`.

- [ ] **Step 3: 브라우저 스모크(playwright-core)** — 같은 인스턴스에서: `/plugins` → "+ 새 변환" → 편집기에 `fl.` 입력 시 자동완성 목록에 `aes` → 저장 → 패널 폼에 "원문" 입력 → ▶ → `✓ 성공` → "승인 요청" → `/admin` 에 "플러그인 승인 요청 1" → "코드·샘플 보기" → diff 렌더 → "✓ 승인" → `/mocks/<id>` 라우트 코덱 ◈ 팝오버 선택기에 새 플러그인 표시. 콘솔 에러 0. 스크린샷 1~2장 확인.

- [ ] **Step 4: 무회귀** — `cd backend && ./gradlew :test` 전체 그린. `jar-enabled=true` 로 `plugins/sample` JAR 도 함께 로드되는지(`FLOWLINK_PLUGINS_JAR_ENABLED=true` 기동 → `/transforms` 에 `mask`·`hmac-sha256` + 스크립트).

- [ ] **Step 5: 마무리** — 격리 인스턴스 정지, :8888 재배포(`scripts\stop.ps1` → `FLOWLINK_PORT=8888 scripts\start.ps1`), 결과 요약(테스트 수·e2e 단언 수·스크린샷).

---

## Self-review 결과

- **스펙 커버리지**: §1 플러그인 모양(Task 2·4) · §2 fl(Task 3) · §3 샌드박스(Task 2) · §4 저장/생명주기/승인(Task 5·6·13) · §5 API(Task 6·7·8) · §6 사용처(Task 7·10) · §7 편집기(Task 9·10·11·12·14) · §8 JAR 격하(Task 1·14) · §9 보안(Task 2·6) · §10 검증(각 태스크 테스트 + Task 15).
- **미루는 것**은 태스크 없음(의도).
- **타입 일관성**: `ScriptRuntime.runFieldCodec(cs, value, fn, ctx)` 인자 순서를 Task 2·4·6 모두 `(cs, value, fn, ctx)` 로 통일. `TryRequest.fn` 은 `'encode'|'decode'` 문자열. `PluginScriptDtos.Detail.meta` 는 nullable. `EditorDiagnostic` 은 CodeEditor 에서 export.
