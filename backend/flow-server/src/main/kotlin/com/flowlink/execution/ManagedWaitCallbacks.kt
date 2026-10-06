package com.flowlink.execution

import org.springframework.stereotype.Component
import java.util.UUID

@Component
class ManagedWaitCallbacks(private val service: ExecutionService) : WaitCallbackReceiver {
    override fun receive(execId: UUID, nodeId: String, method: String, headers: Map<String, String>, body: String): CallbackAck {
        val response = service.recordWaitCallback(execId, nodeId, method, headers, body)
        return CallbackAck(response.contentType, response.body)
    }
}
