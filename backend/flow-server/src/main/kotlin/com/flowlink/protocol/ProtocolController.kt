package com.flowlink.protocol

import org.springframework.http.HttpStatus
import org.springframework.web.bind.annotation.*
import java.util.UUID

@RestController
@RequestMapping("/api/v1/protocols")
class ProtocolController(private val service: ProtocolService) {
    @GetMapping fun list(@RequestParam(required = false) workspaceId: String?): List<ProtocolDtos.Summary> = service.list(workspaceId)
    @PostMapping @ResponseStatus(HttpStatus.CREATED) fun create(@RequestBody req: ProtocolDtos.SaveRequest): ProtocolDtos.Detail = service.create(req.name, req.spec, req.workspaceId)
    @GetMapping("/{id}") fun get(@PathVariable id: UUID): ProtocolDtos.Detail = service.get(id)
    @PutMapping("/{id}") fun update(@PathVariable id: UUID, @RequestBody req: ProtocolDtos.SaveRequest): ProtocolDtos.Detail = service.update(id, req.name, req.spec)
    @DeleteMapping("/{id}") @ResponseStatus(HttpStatus.NO_CONTENT) fun delete(@PathVariable id: UUID) = service.delete(id)
    @PostMapping("/preview") fun preview(@RequestBody req: ProtocolDtos.PreviewRequest, @RequestParam(required = false) workspaceId: String?): ProtocolDtos.PreviewResult = service.preview(req, workspaceId)
}
