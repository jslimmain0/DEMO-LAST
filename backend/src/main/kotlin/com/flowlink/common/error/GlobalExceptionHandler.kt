package com.flowlink.common.error

import jakarta.servlet.http.HttpServletRequest
import org.springframework.dao.OptimisticLockingFailureException
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.validation.FieldError
import org.springframework.web.bind.MethodArgumentNotValidException
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.bind.annotation.RestControllerAdvice

/** 컨트롤러 예외를 표준 [ApiError] 응답으로 변환한다. */
@RestControllerAdvice
class GlobalExceptionHandler {

    @ExceptionHandler(NotFoundException::class)
    fun handleNotFound(ex: NotFoundException, req: HttpServletRequest): ResponseEntity<ApiError> =
        build(HttpStatus.NOT_FOUND, ex.message, req, listOf())

    @ExceptionHandler(BadRequestException::class)
    fun handleBadRequest(ex: BadRequestException, req: HttpServletRequest): ResponseEntity<ApiError> =
        build(HttpStatus.BAD_REQUEST, ex.message, req, listOf())

    @ExceptionHandler(OptimisticLockingFailureException::class)
    fun handleConflict(ex: OptimisticLockingFailureException, req: HttpServletRequest): ResponseEntity<ApiError> =
        build(HttpStatus.CONFLICT,
            "다른 사용자가 먼저 수정했습니다. 최신 상태를 다시 불러온 뒤 재시도하세요.", req, listOf())

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
