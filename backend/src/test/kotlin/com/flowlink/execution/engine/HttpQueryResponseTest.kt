package com.flowlink.execution.engine

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

/**
 * respType=query 의 쿼리스트링 추출 규칙 검증 — 응답 본문이 리다이렉트 URL(…?a=1&b=2),
 * ?쿼리, 맨몸 쿼리(a=1&b=2)일 때 파라미터 부분만 뽑아낸다.
 */
class HttpQueryResponseTest {

    @Test
    fun fullUrlWithQuery() {
        assertEquals(
            "code=0000&tid=T-9",
            HttpNodeExecutor.extractQueryString("https://pg.example.com/return?code=0000&tid=T-9")
        )
    }

    @Test
    fun relativePathAndLeadingQuestionMark() {
        assertEquals("a=1&b=2", HttpNodeExecutor.extractQueryString("/cb?a=1&b=2"))
        assertEquals("a=1&b=2", HttpNodeExecutor.extractQueryString("?a=1&b=2"))
    }

    @Test
    fun bareQueryStringWithoutQuestionMark() {
        assertEquals("a=1&b=2", HttpNodeExecutor.extractQueryString("a=1&b=2"))
        assertEquals("a=%ED%95%9C", HttpNodeExecutor.extractQueryString(" a=%ED%95%9C \n"))
    }

    @Test
    fun fragmentIsStripped() {
        assertEquals("a=1", HttpNodeExecutor.extractQueryString("https://x/y?a=1#section"))
    }

    @Test
    fun nonQueryBodiesReturnNull() {
        assertNull(HttpNodeExecutor.extractQueryString(null))
        assertNull(HttpNodeExecutor.extractQueryString(""))
        assertNull(HttpNodeExecutor.extractQueryString("   "))
        assertNull(HttpNodeExecutor.extractQueryString("hello world")) // '=' 없음
        assertNull(HttpNodeExecutor.extractQueryString("https://x/path")) // '?' 도 '=' 도 없음
        assertNull(HttpNodeExecutor.extractQueryString("line1=1\nline2=2")) // 여러 줄 텍스트는 쿼리로 오인하지 않음
    }

    @Test
    fun urlWithoutParamsYieldsEmptyQuery() {
        // '?' 는 있으나 파라미터가 없는 경우 — 빈 문자열이 나오고, parseQuery 가 body 보존으로 폴백한다.
        assertEquals("", HttpNodeExecutor.extractQueryString("https://x/y?"))
    }
}
