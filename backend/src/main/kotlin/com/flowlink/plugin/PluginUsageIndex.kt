package com.flowlink.plugin

import org.springframework.stereotype.Component

/** pluginId 사용처 인덱스 — Task 7 에서 그래프/Mock/프로토콜 스캔으로 채운다. */
@Component
class PluginUsageIndex {
    data class Ref(val kind: String, val id: String, val name: String)
    fun refs(pluginId: String): List<Ref> = emptyList()
    fun count(pluginId: String): Int = refs(pluginId).size
}
