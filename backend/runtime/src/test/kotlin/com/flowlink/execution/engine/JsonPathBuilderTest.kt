package com.flowlink.execution.engine

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

/** 요청 JSON 경로 확장 — 점 경로/배열 인덱스가 중첩 구조로 조립되는지(응답 dig 의 대칭). */
class JsonPathBuilderTest {

    private fun build(vararg kv: Pair<String, Any?>): LinkedHashMap<String, Any?> {
        val m = LinkedHashMap<String, Any?>()
        for ((k, v) in kv) JsonPathBuilder.put(m, k, v)
        return m
    }

    @Test
    fun `평평한 키는 그대로(무회귀)`() {
        assertEquals(mapOf("name" to "kim", "amt" to 500), build("name" to "kim", "amt" to 500))
    }

    @Test
    fun `점 경로가 중첩 객체로 조립된다`() {
        val m = build("customer.name" to "kim", "customer.grade" to "VIP", "approval.code" to "0000")
        assertEquals(
            mapOf(
                "customer" to mapOf("name" to "kim", "grade" to "VIP"),
                "approval" to mapOf("code" to "0000"),
            ),
            m,
        )
    }

    @Test
    fun `배열 인덱스가 리스트로 조립된다`() {
        val m = build("items[0].sku" to "A-100", "items[0].qty" to 2, "items[1].sku" to "B-200")
        assertEquals(
            mapOf("items" to listOf(mapOf("sku" to "A-100", "qty" to 2), mapOf("sku" to "B-200"))),
            m,
        )
    }

    @Test
    fun `깊은 경로와 인덱스 갭`() {
        val m = build("a.b.c.d" to 1, "list[2]" to "x")
        assertEquals(mapOf("a" to mapOf("b" to mapOf("c" to mapOf("d" to 1))), "list" to listOf(null, null, "x")), m)
    }

    @Test
    fun `타입이 바뀌면 새 컨테이너로 교체(마지막 쓰기 승)`() {
        val m = build("a" to "스칼라", "a.b" to 1)
        assertEquals(mapOf("a" to mapOf("b" to 1)), m)
    }
}
