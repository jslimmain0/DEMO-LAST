package com.flowlink.core.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Index;
import jakarta.persistence.Table;

import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

/**
 * 실행 중 개별 노드의 결과 한 건. 요청/응답 텍스트와 산출 출력을 보관해 디버깅·감사·재현을 돕는다.
 */
@Entity
@Table(name = "node_execution", indexes = {
        @Index(name = "idx_node_exec_execution", columnList = "execution_id")
})
public class NodeExecution {

    @Id
    @Column(nullable = false, updatable = false)
    private UUID id;

    @Column(name = "execution_id", nullable = false)
    private UUID executionId;

    @Column(name = "node_id", nullable = false)
    private String nodeId;

    @Column(name = "node_name")
    private String nodeName;

    @Column(name = "node_type", length = 20)
    private String nodeType;

    /** 같은 실행 내 노드 처리 순서. */
    @Column(name = "seq", nullable = false)
    private int seq;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    private NodeExecutionStatus status;

    @Column(name = "http_status")
    private Integer httpStatus;

    @Column(name = "duration_ms")
    private Long durationMs;

    @Column(name = "ok", nullable = false)
    private boolean ok;

    @Column(name = "request_text", columnDefinition = "text")
    private String requestText;

    @Column(name = "response_text", columnDefinition = "text")
    private String responseText;

    /** 이 노드가 ctx 로 내보낸 출력(JSON 문자열, 시크릿은 마스킹된 형태). */
    @Column(name = "output_json", columnDefinition = "text")
    private String outputJson;

    @Column(name = "started_at")
    private Instant startedAt;

    @Column(name = "finished_at")
    private Instant finishedAt;

    protected NodeExecution() {
    }

    public static NodeExecution of(UUID executionId, String nodeId, String nodeName,
                                   String nodeType, int seq) {
        NodeExecution n = new NodeExecution();
        n.id = UUID.randomUUID();
        n.executionId = executionId;
        n.nodeId = nodeId;
        n.nodeName = nodeName;
        n.nodeType = nodeType;
        n.seq = seq;
        n.status = NodeExecutionStatus.RUNNING;
        n.startedAt = Instant.now();
        n.ok = false;
        return n;
    }

    public void complete(NodeExecutionStatus status, boolean ok, Integer httpStatus,
                         String requestText, String responseText, String outputJson, long durationMs) {
        this.status = status;
        this.ok = ok;
        this.httpStatus = httpStatus;
        this.requestText = requestText;
        this.responseText = responseText;
        this.outputJson = outputJson;
        this.durationMs = durationMs;
        this.finishedAt = Instant.now();
    }

    public UUID getId() {
        return id;
    }

    public UUID getExecutionId() {
        return executionId;
    }

    public String getNodeId() {
        return nodeId;
    }

    public String getNodeName() {
        return nodeName;
    }

    public String getNodeType() {
        return nodeType;
    }

    public int getSeq() {
        return seq;
    }

    public NodeExecutionStatus getStatus() {
        return status;
    }

    public Integer getHttpStatus() {
        return httpStatus;
    }

    public Long getDurationMs() {
        return durationMs;
    }

    public boolean isOk() {
        return ok;
    }

    public String getRequestText() {
        return requestText;
    }

    public String getResponseText() {
        return responseText;
    }

    public String getOutputJson() {
        return outputJson;
    }

    public Instant getStartedAt() {
        return startedAt;
    }

    public Instant getFinishedAt() {
        return finishedAt;
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) {
            return true;
        }
        return o instanceof NodeExecution other && id != null && id.equals(other.id);
    }

    @Override
    public int hashCode() {
        return Objects.hashCode(id);
    }
}
