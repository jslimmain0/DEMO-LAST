package com.flowlink.core.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import org.hibernate.annotations.CreationTimestamp;

import java.time.Instant;
import java.util.Objects;
import java.util.UUID;

/**
 * 워크플로 1회 실행(run)의 헤더. 노드별 상세는 {@link NodeExecution} 에 1:N 으로 기록된다.
 * 실행 이력을 영속화해 감사/재현/관측의 기반으로 삼는다.
 */
@Entity
@Table(name = "execution")
public class Execution {

    @Id
    @Column(nullable = false, updatable = false)
    private UUID id;

    @Column(name = "tenant_id", nullable = false)
    private String tenantId;

    @Column(name = "flow_id", nullable = false)
    private UUID flowId;

    @Column(name = "flow_version_id", nullable = false)
    private UUID flowVersionId;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 20)
    private ExecutionStatus status;

    @Enumerated(EnumType.STRING)
    @Column(name = "trigger_type", nullable = false, length = 20)
    private TriggerType trigger;

    @Column(name = "triggered_by")
    private String triggeredBy;

    /** 실행 시작 시 주입한 입력 변수(JSON 문자열). */
    @Column(name = "input_json", columnDefinition = "text")
    private String inputJson;

    @Column(name = "started_at")
    private Instant startedAt;

    @Column(name = "finished_at")
    private Instant finishedAt;

    @Column(columnDefinition = "text")
    private String error;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    protected Execution() {
    }

    public static Execution start(String tenantId, UUID flowId, UUID flowVersionId,
                                  TriggerType trigger, String triggeredBy, String inputJson) {
        Execution e = new Execution();
        e.id = UUID.randomUUID();
        e.tenantId = tenantId;
        e.flowId = flowId;
        e.flowVersionId = flowVersionId;
        e.trigger = trigger;
        e.triggeredBy = triggeredBy;
        e.inputJson = inputJson;
        e.status = ExecutionStatus.RUNNING;
        e.startedAt = Instant.now();
        return e;
    }

    public void markSucceeded() {
        this.status = ExecutionStatus.SUCCEEDED;
        this.finishedAt = Instant.now();
    }

    public void markFailed(String error) {
        this.status = ExecutionStatus.FAILED;
        this.error = error;
        this.finishedAt = Instant.now();
    }

    public void markWaiting() {
        this.status = ExecutionStatus.WAITING;
    }

    /** 사용자가 대기 중 실행을 중단(⏹)한 경우. */
    public void markCancelled() {
        this.status = ExecutionStatus.CANCELLED;
        this.finishedAt = Instant.now();
    }

    public UUID getId() {
        return id;
    }

    public String getTenantId() {
        return tenantId;
    }

    public UUID getFlowId() {
        return flowId;
    }

    public UUID getFlowVersionId() {
        return flowVersionId;
    }

    public ExecutionStatus getStatus() {
        return status;
    }

    public TriggerType getTrigger() {
        return trigger;
    }

    public String getTriggeredBy() {
        return triggeredBy;
    }

    public String getInputJson() {
        return inputJson;
    }

    public Instant getStartedAt() {
        return startedAt;
    }

    public Instant getFinishedAt() {
        return finishedAt;
    }

    public String getError() {
        return error;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) {
            return true;
        }
        return o instanceof Execution other && id != null && id.equals(other.id);
    }

    @Override
    public int hashCode() {
        return Objects.hashCode(id);
    }
}
