package com.flowlink.execution

import java.util.UUID

data class CallbackAck(val contentType: String, val body: String)
fun interface WaitCallbackReceiver {
    fun receive(execId: UUID, nodeId: String, method: String, headers: Map<String, String>, body: String): CallbackAck
}
