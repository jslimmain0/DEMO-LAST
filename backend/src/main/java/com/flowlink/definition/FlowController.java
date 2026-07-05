package com.flowlink.definition;

import com.fasterxml.jackson.databind.JsonNode;
import com.flowlink.definition.dto.CreateFlowRequest;
import com.flowlink.definition.dto.FlowDetail;
import com.flowlink.definition.dto.FlowSummary;
import com.flowlink.definition.dto.FlowVersionSummary;
import com.flowlink.definition.dto.SaveVersionRequest;
import com.flowlink.folder.FolderDtos.MoveFlowRequest;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.UUID;

/** 워크플로 정의 CRUD + 버전 저장 + 프로토타입 호환 import. */
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

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable UUID id) {
        service.archive(id);
    }

    @PutMapping("/{id}/folder")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void move(@PathVariable UUID id, @RequestBody MoveFlowRequest req) {
        service.moveToFolder(id, req.folderId());
    }

    @PostMapping("/{id}/versions")
    @ResponseStatus(HttpStatus.CREATED)
    public FlowVersionSummary saveVersion(@PathVariable UUID id, @Valid @RequestBody SaveVersionRequest req) {
        return service.saveVersion(id, req.graph(), req.note());
    }

    @PostMapping("/import")
    @ResponseStatus(HttpStatus.CREATED)
    public FlowDetail importFlow(@RequestBody JsonNode export) {
        return service.importFlow(export);
    }
}
