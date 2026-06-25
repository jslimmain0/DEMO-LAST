package com.flowlink.definition.dto;

import jakarta.validation.constraints.Size;

/** 메타데이터 부분 수정. null 필드는 변경하지 않는다. */
public record UpdateFlowRequest(
        @Size(max = 255) String name,
        @Size(max = 2000) String description
) {
}
