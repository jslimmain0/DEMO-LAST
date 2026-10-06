package com.flowlink.common.json

import com.fasterxml.jackson.core.JsonProcessingException
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.flowlink.common.error.BadRequestException
import com.flowlink.core.graph.FlowGraph
import org.springframework.stereotype.Component

/** Jackson 래퍼 — 파싱 실패를 일관된 400 오류로 변환한다. */
@Component
class JsonService(private val mapper: ObjectMapper) {

    fun toJson(value: Any?): String =
        try {
            mapper.writeValueAsString(value)
        } catch (e: JsonProcessingException) {
            throw IllegalStateException("JSON 직렬화 실패", e)
        }

    fun readTree(json: String): JsonNode =
        try {
            mapper.readTree(json)
        } catch (e: JsonProcessingException) {
            throw BadRequestException("올바른 JSON이 아닙니다: " + e.originalMessage)
        }

    fun parseGraph(json: String): FlowGraph =
        try {
            mapper.readValue(json, FlowGraph::class.java)
                ?: throw BadRequestException("빈 그래프입니다.")
        } catch (e: JsonProcessingException) {
            throw BadRequestException("그래프 JSON 파싱 실패: " + e.originalMessage)
        }

    fun mapper(): ObjectMapper = mapper
}
