package com.flowlink.execution.engine;

import org.springframework.stereotype.Component;

import java.util.Deque;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedDeque;

/**
 * 콜백 수신 relay 의 인메모리 상태 — (실행ID, 노드ID) 단위의 <b>수신 버퍼</b>와 <b>등록된 응답</b>.
 *
 * <ul>
 *   <li><b>버퍼</b>: 콜백이 wait 노드 도달 <i>전에</i> 오면(예: 승인 API 응답보다 노티가 먼저) 여기 쌓였다가
 *       wait 도달 즉시 소비된다. 같은 노드로 여러 번 오면 첫 건만 소비되고 나머지는 남는다(무해).</li>
 *   <li><b>응답</b>: wait 노드에 설정한 "콜백에 줄 응답"(형식+본문)을 실행 시작 시점에 등록해 두고,
 *       수신 엔드포인트가 그대로 돌려준다(미등록이면 text/plain "OK").</li>
 * </ul>
 *
 * <p>전부 메모리 — 서버 재시작 시 소실(기존 서스펜션과 동일 한계). 실행 종료 시 {@link #cleanup} 으로 정리.
 */
@Component
public class CallbackRegistry {

    /** 수신 1건 — 파싱된 값 맵(노드 출력 후보) + 원문/메타(로그용). */
    public record Received(Map<String, Object> values, String rawBody, String method, String url) {
    }

    /** 콜백 발신자에게 돌려줄 응답. */
    public record Reply(String contentType, String body) {
        public static final Reply DEFAULT = new Reply("text/plain;charset=UTF-8", "OK");
    }

    private static final int MAX_BUFFERED_PER_NODE = 20;

    private final Map<String, Deque<Received>> buffers = new ConcurrentHashMap<>();
    private final Map<String, Reply> replies = new ConcurrentHashMap<>();

    private static String key(UUID execId, String nodeId) {
        return execId + ":" + nodeId;
    }

    public void registerReply(UUID execId, String nodeId, Reply reply) {
        replies.put(key(execId, nodeId), reply);
    }

    public Reply reply(UUID execId, String nodeId) {
        return replies.getOrDefault(key(execId, nodeId), Reply.DEFAULT);
    }

    public void buffer(UUID execId, String nodeId, Received received) {
        Deque<Received> q = buffers.computeIfAbsent(key(execId, nodeId), k -> new ConcurrentLinkedDeque<>());
        if (q.size() < MAX_BUFFERED_PER_NODE) {
            q.addLast(received);
        }
    }

    /** 버퍼된 콜백 1건을 소비(FIFO). 없으면 null. */
    public Received poll(UUID execId, String nodeId) {
        Deque<Received> q = buffers.get(key(execId, nodeId));
        return q == null ? null : q.pollFirst();
    }

    public boolean hasBuffered(UUID execId, String nodeId) {
        Deque<Received> q = buffers.get(key(execId, nodeId));
        return q != null && !q.isEmpty();
    }

    /** 실행 종료(성공/실패/취소) 시 그 실행의 버퍼·응답을 모두 제거. */
    public void cleanup(UUID execId) {
        String prefix = execId + ":";
        buffers.keySet().removeIf(k -> k.startsWith(prefix));
        replies.keySet().removeIf(k -> k.startsWith(prefix));
    }
}
