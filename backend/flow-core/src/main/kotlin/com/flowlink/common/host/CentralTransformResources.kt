package com.flowlink.common.host

import com.flowlink.transform.FlowTransform

data class CentralTransformDescriptor(val id: String, val label: String, val description: String,
    val inputs: List<FlowTransform.IoSpec>, val outputs: List<FlowTransform.IoSpec>, val params: List<FlowTransform.TransformParam>, val fingerprint: String)
data class CentralTransformRequest(val id: String, val fingerprint: String, val inputs: Map<String, String> = emptyMap(), val config: Map<String, String> = emptyMap())
data class CentralTransformResult(val outputs: Map<String, String>)
