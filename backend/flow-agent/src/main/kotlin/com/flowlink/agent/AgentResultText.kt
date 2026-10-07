package com.flowlink.agent

import com.flowlink.common.json.JsonService

/** 허용·마스킹된 통짜 응답은 원문으로 표시하고, 구조형 응답은 허용 출력만 표시한다. */
object AgentResultText {
    fun response(original: Any?, selected: Map<String, Any?>, json: JsonService): String {
        val body = selected["body"]
        return if (body is String && original is Map<*, *> && original.keys.all { it in setOf("body", "httpStatus") })
            body else json.toJson(selected)
    }
}
