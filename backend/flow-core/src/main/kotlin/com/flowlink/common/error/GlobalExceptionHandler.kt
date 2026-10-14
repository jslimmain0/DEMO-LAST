package com.flowlink.common.error

import jakarta.servlet.http.HttpServletRequest
import org.springframework.dao.OptimisticLockingFailureException
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.http.converter.HttpMessageNotReadableException
import org.springframework.validation.FieldError
import org.springframework.web.bind.MethodArgumentNotValidException
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.bind.annotation.RestControllerAdvice
import org.springframework.web.servlet.resource.NoResourceFoundException
import org.springframework.web.server.ResponseStatusException

/** 컨트롤러 예외를 표준 [ApiError] 응답으로 변환한다. */
@RestControllerAdvice
class GlobalExceptionHandler {

    @ExceptionHandler(com.flowlink.mock.MockActivationException::class)
    fun mockActivation(ex: com.flowlink.mock.MockActivationException, req: HttpServletRequest): ResponseEntity<Map<String, Any?>> =
        ResponseEntity.badRequest().body(mapOf("timestamp" to java.time.Instant.now(), "status" to 400, "error" to "Bad Request", "message" to ex.message,
            "path" to req.requestURI, "code" to ex.code, "previous" to ex.previous, "repairHint" to "현재 리스너를 유지한 상태에서 포트·지원 기능을 확인하고 명시적으로 다시 저장하세요."))

    @ExceptionHandler(com.flowlink.protocol.ProtocolCompiler.CompileException::class)
    fun protocolValidation(ex: com.flowlink.protocol.ProtocolCompiler.CompileException, req: HttpServletRequest): ResponseEntity<Map<String, Any?>> =
        ResponseEntity.badRequest().body(mapOf("timestamp" to java.time.Instant.now(), "status" to 400, "error" to "Bad Request",
            "message" to "전문 정의 검증에 실패했습니다.", "path" to req.requestURI, "code" to (ex.errors.firstOrNull()?.code ?: "INVALID_SCHEMA"),
            "errors" to ex.errors))

    @ExceptionHandler(com.flowlink.protocol.ProtocolCompiler.ProtocolFailure::class)
    fun protocolFailure(ex: com.flowlink.protocol.ProtocolCompiler.ProtocolFailure, req: HttpServletRequest): ResponseEntity<Map<String, Any?>> =
        ResponseEntity.badRequest().body(mapOf("timestamp" to java.time.Instant.now(), "status" to 400, "error" to "Bad Request", "message" to ex.message,
            "path" to req.requestURI, "code" to ex.code, "fieldPath" to ex.path, "phase" to ex.phase, "expectedBytes" to ex.expectedBytes, "actualBytes" to ex.actualBytes, "repairHint" to ex.repairHint))

    @ExceptionHandler(ResponseStatusException::class)
    fun handleStatus(ex: ResponseStatusException, req: HttpServletRequest): ResponseEntity<ApiError> =
        ResponseEntity.status(ex.statusCode).headers(ex.headers).body(ApiError.of(ex.statusCode.value(),
            HttpStatus.resolve(ex.statusCode.value())?.reasonPhrase ?: "요청 오류", ex.reason, req.requestURI, listOf()))

    @ExceptionHandler(com.flowlink.common.lifecycle.UpdateInProgressException::class)
    fun updating(ex: com.flowlink.common.lifecycle.UpdateInProgressException, req: HttpServletRequest): ResponseEntity<ApiError> =
        build(HttpStatus.SERVICE_UNAVAILABLE, ex.message, req, listOf())

    @ExceptionHandler(NotFoundException::class)
    fun handleNotFound(ex: NotFoundException, req: HttpServletRequest): ResponseEntity<ApiError> =
        build(HttpStatus.NOT_FOUND, ex.message, req, listOf())

    @ExceptionHandler(NoResourceFoundException::class)
    fun handleMissingResource(req: HttpServletRequest): ResponseEntity<ApiError> =
        build(HttpStatus.NOT_FOUND, "요청한 경로를 찾을 수 없습니다.", req, listOf())

    @ExceptionHandler(ForbiddenException::class)
    fun forbidden(ex: ForbiddenException, req: jakarta.servlet.http.HttpServletRequest) =
        build(HttpStatus.FORBIDDEN, ex.message, req, listOf())

    @ExceptionHandler(BadRequestException::class)
    fun handleBadRequest(ex: BadRequestException, req: HttpServletRequest): ResponseEntity<ApiError> =
        build(HttpStatus.BAD_REQUEST, ex.message, req, listOf())

    @ExceptionHandler(TooManyRequestsException::class)
    fun handleTooMany(ex: TooManyRequestsException, req: HttpServletRequest): ResponseEntity<ApiError> =
        build(HttpStatus.TOO_MANY_REQUESTS, ex.message, req, listOf())

    @ExceptionHandler(OptimisticLockingFailureException::class)
    fun handleConflict(ex: OptimisticLockingFailureException, req: HttpServletRequest): ResponseEntity<ApiError> =
        build(HttpStatus.CONFLICT,
            "다른 사용자가 먼저 수정했습니다. 최신 상태를 다시 불러온 뒤 재시도하세요.", req, listOf())

    // 깨진/빈 JSON 본문(역직렬화 실패)은 클라이언트 잘못 → 400(구: catch-all 500)
    @ExceptionHandler(HttpMessageNotReadableException::class)
    fun handleUnreadable(ex: HttpMessageNotReadableException, req: HttpServletRequest): ResponseEntity<ApiError> =
        build(HttpStatus.BAD_REQUEST, "요청 본문을 읽을 수 없습니다(형식 오류).", req, listOf())

    @ExceptionHandler(MethodArgumentNotValidException::class)
    fun handleValidation(ex: MethodArgumentNotValidException, req: HttpServletRequest): ResponseEntity<ApiError> {
        val details = ex.bindingResult.fieldErrors.map { formatFieldError(it) }
        return build(HttpStatus.BAD_REQUEST, "요청 본문 검증 실패", req, details)
    }

    @ExceptionHandler(Exception::class)
    fun handleUnexpected(ex: Exception, req: HttpServletRequest): ResponseEntity<ApiError> =
        build(HttpStatus.INTERNAL_SERVER_ERROR,
            "예상치 못한 오류: " + ex.javaClass.simpleName, req, listOf())

    private fun formatFieldError(fe: FieldError): String =
        fe.field + ": " + fe.defaultMessage

    private fun build(status: HttpStatus, message: String?,
                      req: HttpServletRequest, details: List<String>): ResponseEntity<ApiError> {
        val body = ApiError.of(status.value(), status.reasonPhrase, message,
            req.requestURI, details)
        return ResponseEntity.status(status).body(body)
    }
}
