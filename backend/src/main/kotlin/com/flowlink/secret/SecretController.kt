package com.flowlink.secret

import org.springframework.http.HttpStatus
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController

/**
 * 시크릿 볼트 API — write-only. GET 은 이름만(값 조회 불가), PUT 로 설정, DELETE 로 제거.
 * RBAC: GET=viewer, 쓰기=editor(api 경로 규칙). 값은 실행 시 `{{ 이름@secret }}` 로만 쓰인다.
 */
@RestController
@RequestMapping("/api/v1/secrets")
class SecretController(private val service: SecretService) {

    data class PutSecretRequest(val value: String)

    @GetMapping
    fun list(): List<SecretService.SecretView> = service.listNames()

    @PutMapping("/{name}")
    fun put(@PathVariable name: String, @RequestBody req: PutSecretRequest): SecretService.SecretView {
        service.put(name, req.value)
        return service.listNames().first { it.name == name.trim() }
    }

    @DeleteMapping("/{name}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun delete(@PathVariable name: String) = service.delete(name)
}
