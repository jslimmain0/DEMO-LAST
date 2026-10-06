package com.flowlink.mock

import org.springframework.stereotype.Component
import java.time.Instant
import java.util.ArrayDeque
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/**
 * Mock 서버(slug)별 인메모리 런타임 상태 — {{seq}} 카운터·상태 있는 목 KV·규칙 히트수(순차 응답)·요청 기록(journal).
 * 게이트웨이(서빙)와 관리 컨트롤러(조회/리셋)가 공유한다(재시작 시 리셋). server.id 키.
 */
@Component
class MockRuntimeStore {

    private val seqs: MutableMap<UUID, AtomicLong> = ConcurrentHashMap()
    private val states: MutableMap<UUID, MutableMap<String, String>> = ConcurrentHashMap()
    private val hits: MutableMap<UUID, MutableMap<String, Int>> = ConcurrentHashMap()
    private val journals: MutableMap<UUID, ArrayDeque<JournalEntry>> = ConcurrentHashMap()
    private val tcpLogs: MutableMap<UUID, ArrayDeque<TcpLogEntry>> = ConcurrentHashMap()

    /** 서버별 상태 맵(setState 로 쓰고 {{state.x}}/source=state 로 읽음). */
    fun state(id: UUID): MutableMap<String, String> = states.computeIfAbsent(id) { ConcurrentHashMap() }

    /** {{seq}} 다음 값(1000 시작). */
    fun seqNext(id: UUID): Long = seqs.computeIfAbsent(id) { AtomicLong(1000) }.incrementAndGet()

    /** 규칙 히트 스냅샷(순차 응답 repeat 판정용). */
    fun hitsSnapshot(id: UUID): Map<String, Int> = HashMap(hits[id] ?: emptyMap())

    /** 규칙 히트 1 증가. */
    fun recordHit(id: UUID, ruleId: String) {
        hits.computeIfAbsent(id) { ConcurrentHashMap() }.merge(ruleId, 1, Int::plus)
    }

    /** 요청 1건 기록(상한 초과 시 오래된 것 제거). */
    fun record(id: UUID, entry: JournalEntry) {
        val dq = journals.computeIfAbsent(id) { ArrayDeque() }
        synchronized(dq) {
            dq.addFirst(entry)
            while (dq.size > JOURNAL_MAX) dq.removeLast()
        }
    }

    /** 요청 기록(최신순). */
    fun journal(id: UUID): List<JournalEntry> {
        val dq = journals[id] ?: return emptyList()
        synchronized(dq) { return ArrayList(dq) }
    }

    fun clearJournal(id: UUID) { journals[id]?.let { synchronized(it) { it.clear() } } }

    /** TCP 트래픽 1행 기록(최신 우선, 상한 초과 시 오래된 것 제거). */
    fun recordTcp(id: UUID, e: TcpLogEntry) {
        val dq = tcpLogs.computeIfAbsent(id) { ArrayDeque() }
        synchronized(dq) { dq.addFirst(e); while (dq.size > TCP_LOG_MAX) dq.removeLast() }
    }

    /** TCP 트래픽 로그(최신순). */
    fun tcpLog(id: UUID): List<TcpLogEntry> {
        val dq = tcpLogs[id] ?: return emptyList()
        synchronized(dq) { return ArrayList(dq) }
    }

    fun clearTcpLog(id: UUID) { tcpLogs[id]?.let { synchronized(it) { it.clear() } } }

    /** 상태 스냅샷(state·seq·hits·요청수) — 관리 조회용. */
    fun snapshot(id: UUID): Snapshot =
        Snapshot(HashMap(states[id] ?: emptyMap()), seqs[id]?.get() ?: 1000L, HashMap(hits[id] ?: emptyMap()), journals[id]?.size ?: 0)

    /** 전체 초기화(재시작 없이 깨끗한 상태로). */
    fun reset(id: UUID) {
        states.remove(id); seqs.remove(id); hits.remove(id); journals.remove(id); tcpLogs.remove(id)
    }

    /** 서버 삭제 시 상태 정리(누수 방지). */
    fun forget(id: UUID) = reset(id)

    data class JournalEntry(
        val at: Instant,
        val method: String,
        val path: String,
        val query: Map<String, String>,
        val headers: Map<String, String>,
        val bodyText: String,
        val matchedRuleId: String?,
        val status: Int,
        val delayMs: Int,
        val callbackFired: Boolean,
        /** 요청 코덱을 거친 전문(코덱 없으면 null) — 원문(bodyText)과 나란히 보여 디코딩 결과를 확인. */
        val decodedBody: String? = null,
    )

    /** TCP 트래픽 로그 1행 — dir=in|out, source=mock|proxy|none, level=info|warn|error. text 는 ASCII 뷰(깨진 바이트 \xNN). */
    data class TcpLogEntry(
        val at: Instant,
        val dir: String,
        val source: String,
        val key: String?,
        val fields: Map<String, String>,
        val text: String,
        val hex: String,
        val bytes: Int,
        val chunks: List<Int>?,
        val ruleId: String?,
        val note: String?,
        val level: String,
        /** 한 전문이 여러 번에 나뉘어 도착/전송됐다(Framer.Frame.partial · split 장애 주입). */
        val partial: Boolean = false,
    )

    data class Snapshot(val state: Map<String, String>, val seq: Long, val hits: Map<String, Int>, val requestCount: Int)

    companion object {
        const val JOURNAL_MAX = 100
        const val TCP_LOG_MAX = 200
        const val BODY_CAP = 4096
    }
}
