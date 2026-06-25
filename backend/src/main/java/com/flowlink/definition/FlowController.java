package com.flowlink.definition;

import com.fasterxml.jackson.databind.JsonNode;
import com.flowlink.definition.dto.CreateFlowRequest;
import com.flowlink.definition.dto.FlowDetail;
import com.flowlink.definition.dto.FlowSummary;
import com.flowlink.definition.dto.FlowVersionSummary;
import com.flowlink.definition.dto.SaveVersionRequest;
import com.flowlink.definition.dto.UpdateFlowRequest;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.UUID;

/** 워크플로 정의 CRUD + 버전 + 프로토타입 호환 import/export. */
@RestController
@RequestMapping("/api/v1/flows")
public class FlowController {

    private final FlowService service;

    public FlowController(FlowService service) {
        this.service = service;
    }

    @GetMapping
    public List<FlowSummary> list() {
        return service.list();
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public FlowDetail create(@Valid @RequestBody CreateFlowRequest req) {
        return service.create(req);
    }

    @GetMapping("/{id}")
    public FlowDetail get(@PathVariable UUID id) {
        return service.get(id);
    }

    @PatchMapping("/{id}")
    public FlowDetail update(@PathVariable UUID id, @Valid @RequestBody UpdateFlowRequest req) {
        return service.updateMeta(id, req);
    }

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable UUID id) {
        service.archive(id);
    }

    // --- 버전 ---

    @PostMapping("/{id}/versions")
    @ResponseStatus(HttpStatus.CREATED)
    public FlowVersionSummary saveVersion(@PathVariable UUID id, @Valid @RequestBody SaveVersionRequest req) {
        return service.saveVersion(id, req.graph(), req.note());
    }

    @GetMapping("/{id}/versions")
    public List<FlowVersionSummary> versions(@PathVariable UUID id) {
        return service.listVersions(id);
    }

    @GetMapping("/{id}/versions/{versionNo}")
    public JsonNode versionGraph(@PathVariable UUID id, @PathVariable int versionNo) {
        return service.getVersionGraph(id, versionNo);
    }

    // --- import / export (프로토타입 JSON 포맷) ---

    @PostMapping("/import")
    @ResponseStatus(HttpStatus.CREATED)
    public FlowDetail importFlow(@RequestBody JsonNode export) {
        return service.importFlow(export);
    }

    @GetMapping("/{id}/export")
    public ResponseEntity<JsonNode> exportFlow(@PathVariable UUID id) {
        return ResponseEntity.ok(service.exportFlow(id));
    }
}
