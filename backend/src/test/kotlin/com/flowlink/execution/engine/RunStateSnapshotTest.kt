package com.flowlink.execution.engine

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.flowlink.common.json.JsonService
import com.flowlink.core.domain.ExecutionStatus
import com.flowlink.core.graph.FlowGraph
import com.flowlink.execution.config.ExecutionProperties
import com.flowlink.transform.TransformRegistry
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.springframework.web.client.RestClient

/**
 * RunState 스냅샷 → JSON 라운드트립 → rehydrate 후에도 재개가 이어지는지 검증
 * (suspension DB 영속 = 서버 재시작 생존의 코어 규약).
 */
class RunStateSnapshotTest {

    // FlowGraph(코틀린 data class) 파싱에 KotlinModule 필요 — 프로덕션 Spring mapper 와 동일 조건
    private val json = JsonService(jacksonObjectMapper())
    private val tokens = TokenResolver(json)
    private val props = ExecutionProperties(null, null, null, null, 0)
    private val ssrf = SsrfGuard(props)
    private val executor = FlowExecutor(
        tokens, ExpressionEvaluator(tokens),
        HttpNodeExecutor(RestClient.create(), tokens, ssrf, json, OAuthTokenProvider(RestClient.create(), ssrf, tokens, json), props),
        json, TransformRegistry("build/tmp/no-plugins"), TcpNodeExecutor(tokens, ssrf, json)
    )
    private val mapper = jacksonObjectMapper()

    private val graphJson = """
        {"nodes":[
          {"id":"s1","name":"시작","type":"start"},
          {"id":"v1","name":"변수","type":"set","vars":[{"key":"greeting","value":"안녕"},{"key":"amount","value":"1500"}]},
          {"id":"w1","name":"대기","type":"wait","waitTimeoutSec":120},
          {"id":"e1","name":"끝","type":"end"}
        ],"edges":[{"from":"s1","to":"v1"},{"from":"v1","to":"w1"},{"from":"w1","to":"e1"}]}
    """.trimIndent()

    private fun noopRecorder() = NodeRecorder { _, _, _, _, _ -> }

    @Test
    fun snapshotJsonRoundTripThenResume() {
        val graph = json.mapper().readValue(graphJson, FlowGraph::class.java)
        val ctx = ExecutionContext()
        ctx.putSeed("w1", mapOf("url" to "http://cb.example/relay/x/cb/w1"))
        val st = executor.newRun(graph, ctx, "http://cb.example", "run-1")

        val outcome = executor.execute(st, noopRecorder())
        assertEquals(ExecutionStatus.WAITING, outcome.status)
        assertNotNull(outcome.pendingWait)
        assertEquals("w1", outcome.pendingWait!!.nodeId)

        // 스냅샷 → JSON → 복원 (DB 왕복 재현)
        val snap = executor.snapshot(st)
        val roundTripped: RunStateSnapshot = mapper.readValue(mapper.writeValueAsString(snap), RunStateSnapshot::class.java)
        assertEquals(snap.activeIds.toSet(), roundTripped.activeIds.toSet())
        assertEquals(snap.index, roundTripped.index)
        assertEquals(snap.pendingNodeId, roundTripped.pendingNodeId)
        // 삽입 순서 보존 — bare 토큰 nearest-upstream 의미론
        assertEquals(snap.ctxValues.keys.toList(), roundTripped.ctxValues.keys.toList())

        val st2 = executor.rehydrate(graph, roundTripped)
        // 복원된 ctx 에서 상류 출력/시드 조회 가능
        @Suppress("UNCHECKED_CAST")
        val setOut = st2.context().raw("v1") as Map<String, Any?>
        assertEquals("안녕", setOut["greeting"])
        @Suppress("UNCHECKED_CAST")
        val seed = st2.context().raw("w1") as Map<String, Any?>
        assertEquals("http://cb.example/relay/x/cb/w1", seed["url"])

        // 복원 상태에서 콜백 재개 → 완주
        val resumed = executor.resume(
            st2,
            FlowExecutor.ResumeInput(null, null, null, null,
                FlowExecutor.ResumeInput.Callback("POST", "http://cb.example/relay/x/cb/w1", mapOf(), """{"code":"0000"}"""),
                null),
            10, noopRecorder()
        )
        assertEquals(ExecutionStatus.SUCCEEDED, resumed.status)
        @Suppress("UNCHECKED_CAST")
        val waitOut = st2.context().raw("w1") as Map<String, Any?>
        assertEquals("0000", waitOut["code"])
        assertTrue(waitOut.containsKey("url"))
    }
}
