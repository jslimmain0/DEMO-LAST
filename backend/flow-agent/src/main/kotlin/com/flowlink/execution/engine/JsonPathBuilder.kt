package com.flowlink.execution.engine

/**
 * 요청 JSON 조립용 경로 확장 — 필드 키의 점 경로(customer.name)·배열 인덱스(items[0].sku)를
 * 중첩 구조로 만든다. 응답 쪽 TokenResolver.dig(경로 읽기)의 대칭(경로 쓰기).
 * 경로 문자가 없으면 평평한 키 그대로(기존 동작 무회귀). 배열 인덱스 갭은 null 로 채운다.
 */
object JsonPathBuilder {

    @JvmStatic
    fun put(root: LinkedHashMap<String, Any?>, key: String, value: Any?) {
        if (!key.contains('.') && !key.contains('[')) {
            root[key] = value
            return
        }
        val segs = key.replace("]", "").split('.', '[').filter { it.isNotEmpty() }
        if (segs.isEmpty()) {
            root[key] = value
            return
        }
        var cur: Any = root
        for (i in 0 until segs.size - 1) {
            val seg = segs[i]
            val nextIsIndex = segs[i + 1].toIntOrNull() != null
            cur = descend(cur, seg, nextIsIndex) ?: return // 리스트에 비숫자 세그 등 — 조용히 무시(안전)
        }
        val last = segs.last()
        when (cur) {
            is LinkedHashMap<*, *> -> {
                @Suppress("UNCHECKED_CAST")
                (cur as LinkedHashMap<String, Any?>)[last] = value
            }
            is ArrayList<*> -> {
                @Suppress("UNCHECKED_CAST")
                val l = cur as ArrayList<Any?>
                val idx = last.toIntOrNull() ?: return
                while (l.size <= idx) l.add(null)
                l[idx] = value
            }
        }
    }

    /** 컨테이너에서 seg 위치의 자식 컨테이너를 얻거나 만든다(타입이 안 맞으면 새로 교체). */
    private fun descend(cur: Any, seg: String, nextIsIndex: Boolean): Any? {
        return when (cur) {
            is LinkedHashMap<*, *> -> {
                @Suppress("UNCHECKED_CAST")
                val m = cur as LinkedHashMap<String, Any?>
                val existing = m[seg]
                when {
                    nextIsIndex && existing is ArrayList<*> -> existing
                    !nextIsIndex && existing is LinkedHashMap<*, *> -> existing
                    else -> newChild(nextIsIndex).also { m[seg] = it }
                }
            }
            is ArrayList<*> -> {
                @Suppress("UNCHECKED_CAST")
                val l = cur as ArrayList<Any?>
                val idx = seg.toIntOrNull() ?: return null
                while (l.size <= idx) l.add(null)
                val existing = l[idx]
                when {
                    nextIsIndex && existing is ArrayList<*> -> existing
                    !nextIsIndex && existing is LinkedHashMap<*, *> -> existing
                    else -> newChild(nextIsIndex).also { l[idx] = it }
                }
            }
            else -> null
        }
    }

    private fun newChild(isIndex: Boolean): Any = if (isIndex) ArrayList<Any?>() else LinkedHashMap<String, Any?>()
}
