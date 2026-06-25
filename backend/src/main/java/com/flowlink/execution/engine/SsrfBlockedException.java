package com.flowlink.execution.engine;

/** SSRF 가드가 요청을 차단했을 때. */
public class SsrfBlockedException extends RuntimeException {

    public SsrfBlockedException(String message) {
        super(message);
    }
}
