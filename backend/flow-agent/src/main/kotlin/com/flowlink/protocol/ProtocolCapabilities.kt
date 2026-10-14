package com.flowlink.protocol

/** Reported by the executing binary, never inferred from a server distribution manifest. */
object ProtocolCapabilities {
    val schemaVersions = listOf(1, 2)
    val features = listOf("transactionFraming", "transactionAck", "ackLengthOnly", "ackMessageTemplates", "ackFieldValidation", "binaryIntegers", "mockPreview",
        "lengthAdjustment", "fixedFraming", "delimiterFraming", "responseFraming", "connectionReuse", "approvedCodecs").associateWith { "supported" }
}
