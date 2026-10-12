package com.flowlink.mock

import com.flowlink.agent.CentralResourceIdentity
import com.flowlink.common.host.CentralTransformDescriptor
import com.flowlink.common.host.CentralTransformRequest
import com.flowlink.common.host.LocalServerResources
import com.flowlink.transform.FlowTransform

internal class CentralMockTransforms(private val server: LocalServerResources, private val identity: CentralResourceIdentity) {
    private val entries by lazy { server.transforms(identity).associate { it.id to proxy(it) } }
    fun find(id: String): FlowTransform? = entries[id]
    private fun proxy(descriptor: CentralTransformDescriptor) = object : FlowTransform {
        override fun id() = descriptor.id
        override fun label() = descriptor.label
        override fun description() = descriptor.description
        override fun inputs() = descriptor.inputs
        override fun outputs() = descriptor.outputs
        override fun params() = descriptor.params
        override fun apply(inputs: Map<String, String>, config: Map<String, String>) =
            server.transform(CentralTransformRequest(descriptor.id, descriptor.fingerprint, inputs, config), identity).outputs
    }
}
