package com.flowlink.execution

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.node.ObjectNode
import com.flowlink.common.crypto.CryptoProvider
import com.flowlink.common.error.BadRequestException
import com.flowlink.execution.dto.RunRequest

/** 기존 input CLOB에 입력과 암호화된 재실행 조건을 함께 보존한다. 장치·실행 ID는 새 호출자가 정한다. */
internal class ExecutionReplay(private val mapper: ObjectMapper, private val crypto: CryptoProvider) {
    private val marker = "FlowLink.ExecutionRequest.v1"

    fun store(request: RunRequest?): String {
        val original = request ?: RunRequest(null, null, null, null)
        val options = original.copy(input = null, versionNo = null, agentDeviceId = null, clientExecutionId = null)
        val envelope = mapper.createObjectNode().apply {
            put("marker", marker)
            set<JsonNode>("input", original.input ?: mapper.nullNode())
            put("encryptedOptions", crypto.encrypt(mapper.writeValueAsString(options)))
        }
        return mapper.writeValueAsString(envelope)
    }

    fun restore(raw: String?, managed: Boolean, versionNo: Int, overrides: RunRequest?): RunRequest {
        val stored = try { raw?.let(mapper::readTree) }
        catch (_: Exception) { throw BadRequestException("원래 실행 조건을 읽지 못했습니다. 에디터에서 새로 실행하세요.") }
        val storedMarker = stored?.path("marker")?.asText()
        if (storedMarker?.startsWith("FlowLink.ExecutionRequest.") == true && storedMarker != marker)
            throw BadRequestException("이 실행 조건의 저장 형식을 지원하지 않습니다. 에디터에서 새로 실행하세요.")
        val isEnvelope = stored?.isObject == true && stored.path("marker").asText() == marker
        if (!isEnvelope && managed) throw BadRequestException("이 실행에는 원래 테스트 범위·환경 정보가 없습니다. 에디터에서 실행 계획을 확인하고 새로 실행하세요.")
        val input = if (isEnvelope) stored!!.get("input")?.takeUnless { it.isNull } else stored
        val original = if (isEnvelope) {
            try {
                require(stored!!.has("input") && stored.path("encryptedOptions").isTextual)
                mapper.readValue(crypto.decrypt(stored.path("encryptedOptions").asText()), RunRequest::class.java)
            } catch (_: Exception) {
                throw BadRequestException("원래 실행 조건을 복원하지 못했습니다. 에디터에서 실행 계획을 확인하고 새로 실행하세요.")
            }
        } else RunRequest(null, null, null, null)
        val options = mapper.valueToTree<ObjectNode>(original)
        overrides?.let { request ->
            mapper.valueToTree<ObjectNode>(request).fields().forEach { (name, value) ->
                // DTO에서 미지정 nullable 값은 null, 미지정 연결 맵은 빈 객체로 들어온다.
                if (name !in setOf("input", "versionNo", "agentDeviceId", "clientExecutionId") && !value.isNull &&
                    !(name in setOf("agentDependencies", "agentEnvironments") && value.isObject && value.size() == 0)) {
                    options.set<JsonNode>(name, value)
                }
            }
        }
        return mapper.treeToValue(options, RunRequest::class.java).copy(
            input = input, versionNo = versionNo,
            agentDeviceId = overrides?.agentDeviceId, clientExecutionId = overrides?.clientExecutionId,
        )
    }
}
