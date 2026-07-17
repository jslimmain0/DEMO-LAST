package com.flowlink.definition

import com.fasterxml.jackson.databind.JsonNode
import com.flowlink.definition.dto.CreateFlowRequest
import com.flowlink.definition.dto.FlowDetail
import com.flowlink.definition.dto.FlowSummary
import com.flowlink.definition.dto.FlowVersionSummary
import com.flowlink.definition.dto.SaveVersionRequest
import com.flowlink.definition.dto.UpdateFlowMetaRequest
import com.flowlink.folder.FolderDtos.MoveFlowRequest
import jakarta.validation.Valid
import org.springframework.http.HttpStatus
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PatchMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController
import java.util.UUID

/** 워크플로 정의 CRUD + 버전 저장 + 프로토타입 호환 import. */
@RestController
@RequestMapping("/api/v1/flows")
class FlowController(private val service: FlowService) {

    @GetMapping
    fun list(): List<FlowSummary> = service.list()

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    fun create(@Valid @RequestBody req: CreateFlowRequest): FlowDetail = service.create(req)

    @GetMapping("/{id}")
    fun get(@PathVariable id: UUID): FlowDetail = service.get(id)

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun delete(@PathVariable id: UUID) {
        service.archive(id)
    }

    @PutMapping("/{id}/folder")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun move(@PathVariable id: UUID, @RequestBody req: MoveFlowRequest) {
        service.moveToFolder(id, req.folderId)
    }

    // 이름·설명 편집(에디터를 열지 않고 대시보드에서) — 버전 그래프는 건드리지 않는다
    @PatchMapping("/{id}")
    fun updateMeta(@PathVariable id: UUID, @Valid @RequestBody req: UpdateFlowMetaRequest): FlowDetail =
        service.updateMeta(id, req.name, req.description)

    @PostMapping("/{id}/versions")
    @ResponseStatus(HttpStatus.CREATED)
    fun saveVersion(@PathVariable id: UUID, @Valid @RequestBody req: SaveVersionRequest): FlowVersionSummary =
        service.saveVersion(id, req.graph, req.note)

    @PostMapping("/import")
    @ResponseStatus(HttpStatus.CREATED)
    fun importFlow(@RequestBody export: JsonNode): FlowDetail = service.importFlow(export)
}
