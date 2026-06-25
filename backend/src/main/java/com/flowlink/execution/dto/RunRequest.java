package com.flowlink.execution.dto;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * 실행 요청. {@code input} 은 실행 시작 시 주입할 초기 변수(선택), {@code versionNo} 가 null 이면 현재 버전 실행.
 * input 의 키는 {@code {{ key@input }}} 또는 bare {@code {{ key }}} 로 참조 가능.
 */
public record RunRequest(
        JsonNode input,
        Integer versionNo
) {
}
