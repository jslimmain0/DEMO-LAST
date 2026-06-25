package com.flowlink.common.error;

/** 클라이언트 입력이 유효하지 않을 때. (HTTP 400으로 매핑) */
public class BadRequestException extends RuntimeException {

    public BadRequestException(String message) {
        super(message);
    }
}
