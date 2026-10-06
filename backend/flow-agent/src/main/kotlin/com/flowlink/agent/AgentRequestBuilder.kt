package com.flowlink.agent

import com.fasterxml.jackson.databind.JsonNode
import com.flowlink.common.error.BadRequestException
import com.flowlink.common.json.JsonService
import com.flowlink.common.text.NowTokens
import com.flowlink.core.graph.GraphNode
import com.flowlink.execution.engine.ExecutionContext
import com.flowlink.execution.engine.SecretMasker
import com.flowlink.execution.engine.TokenResolver
import org.springframework.stereotype.Component
import java.util.UUID

@Component
class AgentRequestBuilder(private val json: JsonService, private val tokens: TokenResolver) {
    data class Ref(val key: String, val source: String?, val request: Boolean = false)

    fun references(node: GraphNode): List<Ref> {
        val refs = linkedSetOf<Ref>()
        fun visit(value: JsonNode) {
            if (value.isTextual) {
                val matcher = TokenResolver.tokenPattern().matcher(value.asText())
                while (matcher.find()) refs.add(Ref(matcher.group(1), matcher.group(3), matcher.group(2) != null))
            } else if (value.isObject) {
                if (value.hasNonNull("sourceId") && value.hasNonNull("key"))
                    refs.add(Ref(value["key"].asText(), value["sourceId"].asText(), value.path("scope").asText() == "req"))
                value.elements().forEachRemaining { visit(it) }
            } else if (value.isArray) value.forEach { visit(it) }
        }
        visit(json.mapper().valueToTree(node))
        return refs.toList()
    }

    fun build(node: GraphNode, allNodes: Collection<GraphNode>, ctx: ExecutionContext, run: AgentRunOptions, seq: Int): AgentNodeRequest {
        val transform = node.nodeType() == com.flowlink.core.graph.NodeType.TRANSFORM
        if (transform && run.ownerAgent == "local") throw BadRequestException("플러그인은 공용·팀 워크스페이스에서만 사용할 수 있습니다.")
        val agent = if (transform) "server" else node.executionAgent ?: run.ownerAgent
        if (agent !in setOf("local", "server")) throw BadRequestException("알 수 없는 실행 에이전트: $agent")
        val targetSpace = if (transform) run.workspaceId else if (agent == "local") null else node.agentWorkspaceId
            ?: if (run.ownerAgent == "server") run.workspaceId else "public"
        val cross = agent != run.ownerAgent || (agent == "server" &&
            (targetSpace ?: "public") != (run.workspaceId ?: "public"))
        val environmentKey = if (agent == "local") "local" else "server:${targetSpace ?: "public"}"
        val envName = if (transform) run.envName else node.agentEnvironment ?: if (run.agentEnvironments.containsKey(environmentKey)) run.agentEnvironments.getValue(environmentKey)
            else if (!cross) run.envName else throw BadRequestException("목적지 환경을 선택하세요: $environmentKey (공통 환경도 명시적으로 선택해야 합니다.)")
        val secrets = (ctx.raw("secret") as? Map<*, *>)?.values?.mapNotNull { it as? String }.orEmpty().toMutableList()
        if (run.ownerAgent == "local" && agent == "server" && references(node).any { it.source == "secret" })
            throw BadRequestException("중앙 시크릿은 공용·팀 워크스페이스에서만 사용할 수 있습니다.")
        for (source in allNodes) for (v in source.vars.orEmpty().filter { it.secret }) {
            v.key?.let { key -> tokens.resolveTokenObject(key, false, source.id, ctx)?.let { secrets.add(tokens.stringify(it)) } }
        }
        val masks = SecretMasker.variants(secrets)
        val values = linkedMapOf<String, MutableMap<String, Any?>>()
        val seeds = linkedMapOf<String, Any?>()
        for (ref in references(node)) {
            if (ref.source in setOf("env", "secret")) continue
            val nearest = if (ref.source == null) ctx.keysReversed().firstOrNull {
                !it.startsWith("req:") && tokens.resolveTokenObject(ref.key, false, it, ctx) != null
            } else ref.source
            if (nearest in setOf("env", "secret")) continue
            if (NowTokens.isTimeKey(ref.key) && ((ref.source == null && nearest == null) || NowTokens.isZone(ref.source))) continue
            val value = tokens.resolveTokenObject(ref.key, ref.request, ref.source, ctx)
            if (cross) {
                val serialized = json.toJson(value)
                if (SecretMasker.mask(serialized, masks) != serialized)
                    throw BadRequestException("시크릿 값은 에이전트 경계를 넘길 수 없습니다: ${ref.key}. 목적지 시크릿을 참조하세요.")
            }
            val source = ref.source?.let { (if (ref.request) "req:" else "") + it } ?: "__agent_inputs"
            values.getOrPut(source) { linkedMapOf() }[ref.key] = value
        }
        if (!cross && node.agentEnvironment == null && !run.agentEnvironments.containsKey(environmentKey)) ctx.raw("env")?.let { seeds["env"] = it }
        if (cross && node.vars.orEmpty().any { it.secret && !it.value.isNullOrEmpty() })
            throw BadRequestException("다른 에이전트의 SET 노드에는 목적지 시크릿 참조를 사용하세요.")
        val nodeJson = json.toJson(node)
        if (cross && SecretMasker.mask(nodeJson, masks) != nodeJson) throw BadRequestException("노드 명세에 시크릿 원문이 포함되어 있습니다.")
        val outputs = linkedSetOf<String>()
        val requests = linkedSetOf<String>()
        for (next in allNodes) for (ref in references(next)) {
            if (ref.source == node.id || ref.source == null) {
                if (ref.request) requests.add(ref.key) else outputs.add(ref.key)
            }
        }
        outputs.addAll(node.outputs.orEmpty().mapNotNull { it.key })
        if (node.nodeType().name in setOf("SET", "IF", "ASSERT")) {
            outputs.addAll(node.vars.orEmpty().filterNot { it.secret }.mapNotNull { it.key })
            outputs.add("result"); outputs.add("branch")
        }
        return AgentNodeRequest(
            UUID.nameUUIDFromBytes("${run.executionId}/${node.id}/$seq".toByteArray(Charsets.UTF_8)),
            run.executionId, node.copy(executionAgent = agent, agentWorkspaceId = targetSpace, agentEnvironment = if (transform) null else node.agentEnvironment), values, seeds, targetSpace,
            envName, cross, node.agentOutputs ?: outputs.toList(), requests.toList(),
            run.dependencyHashes[node.id].orEmpty(),
        )
    }
}
