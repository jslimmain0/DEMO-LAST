package com.flowlink.core.graph;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * params/headers/body 한 항목. 값은 리터럴({@code value}) 또는 바인딩({@code bound}) 중 하나.
 *
 * <p>{@code type}: JSON 바디에서 값의 타입(따옴표 여부). string/미지정=기존 동작, number/boolean/json=코어션.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record NodeField(
        String id,
        String key,
        String value,
        Binding bound,
        String type
) {
}
