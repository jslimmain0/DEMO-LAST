package com.flowlink.common.json;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.flowlink.common.error.BadRequestException;
import com.flowlink.core.graph.FlowGraph;
import org.springframework.stereotype.Component;

/** Jackson 래퍼 — 파싱 실패를 일관된 400 오류로 변환한다. */
@Component
public class JsonService {

    private final ObjectMapper mapper;

    public JsonService(ObjectMapper mapper) {
        this.mapper = mapper;
    }

    public String toJson(Object value) {
        try {
            return mapper.writeValueAsString(value);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("JSON 직렬화 실패", e);
        }
    }

    public JsonNode readTree(String json) {
        try {
            return mapper.readTree(json);
        } catch (JsonProcessingException e) {
            throw new BadRequestException("올바른 JSON이 아닙니다: " + e.getOriginalMessage());
        }
    }

    public FlowGraph parseGraph(String json) {
        try {
            FlowGraph g = mapper.readValue(json, FlowGraph.class);
            if (g == null) {
                throw new BadRequestException("빈 그래프입니다.");
            }
            return g;
        } catch (JsonProcessingException e) {
            throw new BadRequestException("그래프 JSON 파싱 실패: " + e.getOriginalMessage());
        }
    }

    public ObjectMapper mapper() {
        return mapper;
    }
}
