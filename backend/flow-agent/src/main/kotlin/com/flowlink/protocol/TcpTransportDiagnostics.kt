package com.flowlink.protocol

import com.flowlink.common.json.JsonService

/** Cross-host diagnostics contain only transport enums/counts and a fingerprint from the accepted plan. */
object TcpTransportDiagnostics {
    fun sanitize(meta: Any?, expectedFingerprint: String?, json: JsonService): Map<String, Any?>? {
        if (meta == null) return null
        val raw = json.mapper().valueToTree<com.fasterxml.jackson.databind.JsonNode>(meta)
        if (!raw.isObject || !raw.path("steps").isArray) return null
        val phases = listOf("REQUEST", "REQUEST_ACK", "RESPONSE", "RESPONSE_ACK", "COMPLETE")
        val statuses = setOf("SUCCEEDED", "FAILED", "SKIPPED")
        val codes = setOf("ACK_TIMEOUT", "ACK_EOF", "ACK_MISMATCH", "ACK_NO_PROGRESS", "ACK_IO", "FRAME_LENGTH_MISMATCH", "FRAME_ERROR", "FRAME_TIMEOUT", "FRAME_EOF", "UNKNOWN_TRANSACTION", "AMBIGUOUS_TRANSACTION", "MISSING_CONTEXT_FIELD", "INVALID_SCHEMA")
        var previousPhase = -1
        val steps = raw.path("steps").take(5).mapNotNull { step ->
            val phase = step.path("phase").asText()
            val ordinal = phases.indexOf(phase)
            val status = step.path("status").asText()
            if (ordinal <= previousPhase || status !in statuses) return@mapNotNull null
            previousPhase = ordinal
            fun count(name: String, max: Int): Int? = step.path(name).takeIf { it.isIntegralNumber && it.canConvertToInt() && it.asInt() in 0..max }?.asInt()
            val limit = if (phase.endsWith("ACK")) 1024 else Framer.MAX_FRAME
            mapOf("phase" to phase, "role" to "client", "direction" to if (status == "SKIPPED" || phase == "COMPLETE") null else if (phase in setOf("REQUEST", "RESPONSE_ACK")) "SEND" else "RECEIVE",
                "status" to status, "expectedBytes" to count("expectedBytes", limit), "actualBytes" to count("actualBytes", limit),
                "durationMs" to step.path("durationMs").takeIf { it.isIntegralNumber && it.canConvertToLong() && it.asLong() in 0..3_600_000 }?.asLong(),
                "validationMode" to step.path("validationMode").asText().takeIf { it in setOf("exact", "length-only", "fields", "hex", "message") },
                "errorCode" to step.path("errorCode").asText().takeIf { it in codes })
        }
        return mapOf("transportStatus" to raw.path("transportStatus").asText().takeIf { it in setOf("SUCCEEDED", "FAILED", "UNKNOWN") }, "steps" to steps,
            "protocolFingerprint" to expectedFingerprint?.takeIf { it.matches(Regex("[0-9a-f]{64}")) })
    }
}
