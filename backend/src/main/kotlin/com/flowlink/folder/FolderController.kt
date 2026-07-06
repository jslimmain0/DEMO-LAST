package com.flowlink.folder

import com.flowlink.folder.FolderDtos.FolderRequest
import com.flowlink.folder.FolderDtos.FolderSummary
import com.flowlink.folder.FolderDtos.MoveFolderRequest
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

@RestController
@RequestMapping("/api/v1/folders")
class FolderController(private val service: FolderService) {

    @GetMapping
    fun list(): List<FolderSummary> = service.list()

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    fun create(@Valid @RequestBody req: FolderRequest): FolderSummary = service.create(req.name, req.parentId)

    @PatchMapping("/{id}")
    fun rename(@PathVariable id: UUID, @Valid @RequestBody req: FolderRequest): FolderSummary =
        service.rename(id, req.name)

    /** 폴더 재배치(드래그 이동) — 새 상위 폴더 지정(null = 루트). 사이클은 400. */
    @PutMapping("/{id}/parent")
    fun move(@PathVariable id: UUID, @RequestBody req: MoveFolderRequest): FolderSummary =
        service.move(id, req.parentId)

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun delete(@PathVariable id: UUID) {
        service.delete(id)
    }
}
