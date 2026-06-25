package com.flowlink.core.graph;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

import java.util.List;

/** HTTP 노드의 입력 묶음(쿼리/헤더/바디). null 리스트는 빈 리스트로 취급한다. */
@JsonIgnoreProperties(ignoreUnknown = true)
public record NodeFields(
        List<NodeField> params,
        List<NodeField> headers,
        List<NodeField> body
) {
    public List<NodeField> paramsOrEmpty() {
        return params == null ? List.of() : params;
    }

    public List<NodeField> headersOrEmpty() {
        return headers == null ? List.of() : headers;
    }

    public List<NodeField> bodyOrEmpty() {
        return body == null ? List.of() : body;
    }
}
