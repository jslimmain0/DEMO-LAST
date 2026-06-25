package com.flowlink.common.error;

/** 요청한 리소스를 찾지 못했을 때. (HTTP 404로 매핑) */
public class NotFoundException extends RuntimeException {

    public NotFoundException(String message) {
        super(message);
    }

    public static NotFoundException of(String type, Object id) {
        return new NotFoundException(type + " not found: " + id);
    }
}
