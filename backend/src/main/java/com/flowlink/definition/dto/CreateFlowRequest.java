package com.flowlink.definition.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record CreateFlowRequest(
        @NotBlank(message = "이름은 필수입니다.")
        @Size(max = 255)
        String name,

        @Size(max = 2000)
        String description
) {
}
