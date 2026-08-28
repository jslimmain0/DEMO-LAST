package com.flowlink.execution.engine

import com.fasterxml.jackson.databind.ObjectMapper
import java.net.URLEncoder

/**
 * 시크릿 마스킹 규칙의 단일 소스 — 캡처/응답 텍스트에서 시크릿 값을 `••••••` 로 치환한다.
 * 원문만 치환하면 쿼리(퍼센트 인코딩)·JSON(따옴표/역슬래시 이스케이프)에서 새므로 변형까지 후보에 넣고,
 * 부분 문자열 시크릿이 잔재를 남기지 않게 **긴 값부터** 치환한다.
 * 전체 실행(NodeRecorder 저장)과 단일 노드 실행 응답이 같은 규칙을 공유한다.
 */
object SecretMasker {

    private val mapper = ObjectMapper()

    /** 시크릿 값 + 인코딩 변형(URL 인코딩·JSON 이스케이프) 마스킹 후보 — 긴 값 우선 정렬, 공백 제외. */
    @JvmStatic
    fun variants(values: Collection<String>): List<String> {
        val out = LinkedHashSet<String>()
        for (v in values) {
            if (v.isBlank()) continue
            out.add(v)
            try { out.add(URLEncoder.encode(v, Charsets.UTF_8)) } catch (_: Exception) {}
            // JSON 이스케이프형 — writeValueAsString("v") 의 양끝 따옴표 제거
            try {
                val j = mapper.writeValueAsString(v)
                if (j.length >= 2) out.add(j.substring(1, j.length - 1))
            } catch (_: Exception) {}
        }
        return out.filter { it.isNotBlank() }.sortedByDescending { it.length }
    }

    /** 텍스트에서 후보 전부를 `••••••` 로 치환(null/빈 후보는 그대로). */
    @JvmStatic
    fun mask(text: String?, masks: List<String>): String? {
        if (text == null || masks.isEmpty()) return text
        var out: String = text
        for (v in masks) if (v.isNotEmpty()) out = out.replace(v, "••••••")
        return out
    }
}
