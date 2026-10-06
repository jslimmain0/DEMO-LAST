package com.flowlink.trigger

import jakarta.validation.Valid
import org.springframework.http.HttpStatus
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController
import java.util.UUID

/** 워크플로 자동 실행 트리거 CRUD(스케줄/웹훅). RBAC: GET=viewer, 쓰기=editor(flows 경로 규칙). */
@RestController
@RequestMapping("/api/v1/flows/{flowId}/triggers")
class TriggerController(private val service: TriggerService) {

    @GetMapping
    fun list(@PathVariable flowId: UUID): List<TriggerView> = service.list(flowId)

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    fun create(@PathVariable flowId: UUID, @Valid @RequestBody req: CreateTriggerRequest): TriggerView =
        service.create(flowId, req)

    @PutMapping("/{id}")
    fun update(@PathVariable flowId: UUID, @PathVariable id: UUID, @RequestBody req: UpdateTriggerRequest): TriggerView =
        service.update(id, req)

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun delete(@PathVariable flowId: UUID, @PathVariable id: UUID) = service.delete(id)
}
