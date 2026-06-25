package com.flowlink.core.graph;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * params/headers/body 한 항목. 값은 리터럴({@code value}) 또는 바인딩({@code bound}) 중 하나.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record NodeField(
        String id,
        String key,
        String value,
        Binding bound
) {
}
